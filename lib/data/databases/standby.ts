import "server-only";

import { and, eq, isNotNull } from "drizzle-orm";

import { getDb } from "../../db/client";
import { databases as databasesTable } from "../../db/schema/control-plane/databases";
import { getCurrentUser } from "../../auth/current-user";
import { deriveKey } from "../../crypto";
import {
  STANDBY_ENGINES,
  type StandbyEngine,
  standbyContainer,
  standbyCost,
  standbyMembersRefusal,
  standbyRefusal,
  standbySupport,
} from "../../databases/standby";
import { effectiveDatabaseImage } from "../../deploy/database-compose";
import { explainNetworkError } from "../../deploy/network";
import { publishDatabaseChanged } from "../../graphql/pubsub";
import { newId } from "../../ids";
import { memberKeepsStandby } from "../../infra/agent-client/cluster-host";
import { connectAgent } from "../../infra/agent-client/connect";
import type { AgentConnection } from "../../infra/agent-client/connection";
import { requireActiveTeamId, requireCapability } from "../../membership";
import type { Cluster } from "../../types/cluster";
import type { Database } from "../../types/database";
import { recordActivity } from "../activity";
import { assembleDatabase } from "../backup-rows";
import { redeployArchs } from "../clusters/architectures";
import { recordOnce } from "../clusters/bundles";
import { pushDatabaseBundle } from "../clusters/database-bundles";
import { syncNameForwarders } from "../clusters/forwarders";
import { pushLeaderRoster } from "../clusters/leader-sync";
import { memberIsEmptying } from "../clusters/member-workloads";
import {
  PlacementRefusedError,
  askLeaderToPlace,
  recordStandby,
  standbyMemberOf,
} from "../clusters/placement";
import { clusterMemberServerIds, getClusterById } from "../clusters/roster";
import { instanceFrozen } from "../deplo-move/freeze";
import { assertNotPausedForMove } from "../deplo-move/source-guard";
import { withKeyedLock } from "../keyed-mutex";
import { getServerById } from "../servers/roster";
import { loadDatabase, mountsFor, requireDatabase } from "./rows";
import {
  databasePassword,
  renderDatabaseStackYaml,
  rerouteDatabase,
  rerouteRequest,
} from "./stack";

// A cluster database's standby copy (spec #176, #218): placed by the leader on another member, following the
// database over the relay, promoted on a failover. https://deplo.build/docs/operations/clusters/standby-copy

const ACTOR = "Deplo";

/** The copy's own login password. Derived, never stored and never shown: it reaches a member inside the agent's RPC. */
export function standbyPassword(databaseId: string): string {
  return deriveKey(`database-standby:${databaseId}`).toString("base64url");
}

const quietly = (what: string) => (e: unknown) =>
  console.warn(
    `[database-standby] ${what}: ${e instanceof Error ? e.message : String(e)}`,
  );

async function onServer<T>(
  serverId: string,
  fn: (conn: AgentConnection) => Promise<T>,
): Promise<T> {
  const conn = await connectAgent(serverId);
  try {
    return await fn(conn);
  } finally {
    conn.close();
  }
}

const argsOf = (db: Database) => ({
  host: db.host,
  username: db.username,
  dbName: db.dbName,
  port: db.port,
  password: standbyPassword(db.id),
});

/** Runs one of the engine's scripts inside a container of the database; throws what the engine said. */
async function run(
  db: Database,
  serverId: string,
  container: string,
  script: string,
): Promise<string> {
  const res = await onServer(serverId, (conn) =>
    conn.exec(db.id, container, script, effectiveDatabaseImage(db)),
  );
  if (res.code !== 0)
    throw new Error(
      (res.stderr || res.stdout).trim().split("\n").at(-1) ||
        `exit ${res.code}`,
    );
  return res.stdout.trim();
}

/** Why this cluster is too small for the engine's copy (MongoDB needs three servers), or null. */
async function tooSmall(
  db: Database,
  engine: StandbyEngine,
  cluster: Cluster,
): Promise<string | null> {
  return standbyMembersRefusal(engine, {
    cluster: cluster.name,
    name: db.name,
    members: (await clusterMemberServerIds(cluster.id)).length,
  });
}

/** Asks the leader for a member other than the database's own; a refusal throws the sentence the user reads. */
async function placeCopy(
  db: Database,
  engine: StandbyEngine,
  cluster: Cluster,
): Promise<string> {
  const names = { cluster: cluster.name, name: db.name };
  const others = (await clusterMemberServerIds(cluster.id)).filter(
    (m) => m !== db.serverId,
  );
  if (others.length === 0) throw new Error(standbyRefusal("one_member", names));
  const small = await tooSmall(db, engine, cluster);
  if (small) throw new Error(small);
  const old: string[] = [];
  for (const m of others) if (!(await memberKeepsStandby(m))) old.push(m);
  if (old.length === others.length)
    throw new Error(standbyRefusal("too_old", names));
  try {
    return await askLeaderToPlace(cluster, {
      kind: "database",
      id: db.id,
      name: db.name,
      environmentId: db.environmentId,
      limitMb: db.resources?.memoryMb ?? 0,
      archs: await redeployArchs("database", db.id),
      exclude: [db.serverId, ...old],
    });
  } catch (e) {
    if (!(e instanceof PlacementRefusedError)) throw e;
    const { reason, neededMb } = e.refusal;
    if (reason === "no_room" || reason === "no_member_online")
      throw new Error(standbyRefusal(reason, { ...names, neededMb }));
    throw e;
  }
}

/** What the leader, the other members and the bundle know about the copy, after it moved or went. */
async function tellCluster(db: Database, cluster: Cluster): Promise<void> {
  await pushLeaderRoster(cluster).catch(quietly(cluster.id));
  await syncNameForwarders(cluster.id).catch(quietly(cluster.id));
  await pushDatabaseBundle(db.id).catch(quietly(db.id));
}

const copyYaml = (db: Database, engine: StandbyEngine, seed: string) =>
  renderDatabaseStackYaml(
    db,
    databasePassword(db),
    engine.start({ ...argsOf(db), primaryHost: db.host, seed }),
  );

/** Makes (or makes again) the copy on `member`: a new seed means the member starts from the database's data as it is now. */
async function seedCopy(
  db: Database,
  engine: StandbyEngine,
  cluster: Cluster,
  member: string,
): Promise<void> {
  const seed = newId("sby");
  await getDb()
    .update(databasesTable)
    .set({ standbySeed: seed })
    .where(eq(databasesTable.id, db.id));
  await recordStandby(db.id, member);
  // The member must hold the database's name before the copy looks for it.
  await pushLeaderRoster(cluster).catch(quietly(cluster.id));
  await syncNameForwarders(cluster.id).catch(quietly(cluster.id));
  await run(db, db.serverId, db.host, engine.prepare(argsOf(db)));
  const res = await onServer(member, (conn) =>
    conn.reroute(rerouteRequest(db, copyYaml(db, engine, seed))),
  );
  if (!res.ok)
    throw new Error(
      explainNetworkError(res.error || "the server could not start the copy"),
    );
  await pushDatabaseBundle(db.id).catch(quietly(db.id));
}

/**
 * Removes the copy from `member` with its data. Only ever a copy's own stack: the same stack name on another
 * member could be the database itself, so the stack is read first and anything else is left alone.
 */
async function removeCopy(db: Database, member: string): Promise<boolean> {
  let gone = true;
  if (member !== db.serverId)
    await onServer(member, async (conn) => {
      const cur = await conn.readStack(db.host);
      const mark = `container_name: ${standbyContainer(db.host)}\n`;
      if (!cur.exists || !cur.yaml.includes(mark)) return;
      const res = await conn.destroyStack(db.host, true);
      if (!res.ok) throw new Error(res.error || "the copy was not removed");
    }).catch((e) => {
      // A member that returns to its cluster removes the stack itself: the placement no longer names it.
      gone = false;
      quietly(`${db.host} on ${member}`)(e);
    });
  await recordStandby(db.id, null);
  return gone;
}

/** Restarts the database once when its engine starts differently while it keeps a copy (MariaDB's binary log). */
async function applySettings(db: Database, engine?: StandbyEngine) {
  if (engine?.settings && db.status === "running") await rerouteDatabase(db.id);
}

const nameOf = async (serverId: string) =>
  (await getServerById(serverId))?.name ?? "another server";

const say = (db: Database, message: string, actor = ACTOR) =>
  recordActivity("database", message, actor, null, db.teamId, null, db.id);

/** Turns the standby copy of a database on a cluster on or off (expert: Advanced). */
export async function setDatabaseStandby(
  id: string,
  on: boolean,
): Promise<void> {
  const { membership } = await requireCapability("configure_databases");
  const user = (await getCurrentUser())!;
  await assertNotPausedForMove("database", id);
  await withKeyedLock(`standby:${id}`, async () => {
    const db = await requireDatabase(id, membership.teamId);
    if (Boolean(db.standby) === on) return;
    const cluster = db.clusterId ? await getClusterById(db.clusterId) : null;
    if (!on) {
      await getDb()
        .update(databasesTable)
        .set({ standby: false, standbySeed: null })
        .where(
          and(
            eq(databasesTable.id, id),
            eq(databasesTable.teamId, membership.teamId),
          ),
        );
      const off = { ...db, standby: false };
      const at = await standbyMemberOf(id);
      if (at) await removeCopy(off, at);
      const engine = STANDBY_ENGINES[db.type];
      if (engine && db.status === "running")
        await run(db, db.serverId, db.host, engine.retire(argsOf(db))).catch(
          quietly(db.host),
        );
      await applySettings(db, engine).catch(quietly(db.host));
      if (cluster) await tellCluster(off, cluster);
      publishDatabaseChanged(id);
      await say(db, `Turned off the standby copy of ${db.name}`, user.name);
      return;
    }
    const engine = STANDBY_ENGINES[db.type];
    const unsupported = standbySupport(db);
    if (!engine || unsupported) throw new Error(unsupported ?? "Not found");
    if (!cluster)
      throw new Error(
        `Place ${db.name} on a cluster first: its standby copy runs on another server of the cluster.`,
      );
    if (db.status !== "running")
      throw new Error(`Start ${db.name} before turning on its standby copy.`);
    // A refusal throws here, before anything is written.
    const member = await placeCopy(db, engine, cluster);
    await getDb()
      .update(databasesTable)
      .set({ standby: true })
      .where(
        and(
          eq(databasesTable.id, id),
          eq(databasesTable.teamId, membership.teamId),
        ),
      );
    const kept = { ...db, standby: true };
    try {
      await applySettings(db, engine);
      await seedCopy(kept, engine, cluster, member);
    } catch (e) {
      await removeCopy(kept, member).catch(quietly(db.host));
      await getDb()
        .update(databasesTable)
        .set({ standby: false, standbySeed: null })
        .where(
          and(
            eq(databasesTable.id, id),
            eq(databasesTable.teamId, membership.teamId),
          ),
        );
      await applySettings(db, engine).catch(quietly(db.host));
      await tellCluster({ ...db, standby: false }, cluster);
      throw new Error(
        `The standby copy of ${db.name} could not be made: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    publishDatabaseChanged(id);
    await say(
      db,
      `Turned on the standby copy of ${db.name}, on ${await nameOf(member)}`,
      user.name,
    );
  });
}

// Deplo acting for itself has no session, which the team-scoped loader requires.
async function loadForDeplo(id: string): Promise<Database | null> {
  const [row] = await getDb()
    .select()
    .from(databasesTable)
    .where(eq(databasesTable.id, id))
    .limit(1);
  return row ? assembleDatabase(row, await mountsFor(row.id)) : null;
}

/**
 * Takes the copy away before the database itself moves or goes; the switch stays as it is. Answers the server
 * that still holds the copy's stack when it could not be reached, or null.
 */
export async function dropStandbyCopy(db: Database): Promise<string | null> {
  const at = await standbyMemberOf(db.id);
  return at && !(await removeCopy(db, at)) ? at : null;
}

/**
 * Makes the copy what the switch asks for, as Deplo: gone when it is off or the database left its cluster, moved
 * off the database's own member or one being emptied, made again when it stopped following, made when missing.
 */
export async function syncStandby(id: string): Promise<void> {
  if (await instanceFrozen()) return;
  await withKeyedLock(`standby:${id}`, async () => {
    const db = await loadForDeplo(id);
    if (!db || db.status === "provisioning" || db.migrationRunId) return;
    let at = await standbyMemberOf(id);
    const engine = STANDBY_ENGINES[db.type];
    const cluster = db.clusterId ? await getClusterById(db.clusterId) : null;
    if (!db.standby || !cluster || !engine || standbySupport(db)) {
      if (at) {
        await removeCopy(db, at);
        if (cluster) await tellCluster(db, cluster);
      }
      return;
    }
    // Beside its database the copy was promoted; on a member that left or is being emptied it has to go elsewhere,
    // and in a cluster that became too small for the engine it goes until a server joins.
    if (
      at &&
      (at === db.serverId ||
        !(await clusterMemberServerIds(cluster.id)).includes(at) ||
        (await memberIsEmptying(at)) ||
        (await tooSmall(db, engine, cluster)))
    ) {
      await removeCopy(db, at);
      at = null;
    }
    if (db.status !== "running") return;
    if (at) {
      const state = await run(
        db,
        at,
        standbyContainer(db.host),
        engine.check,
      ).catch(() => "");
      if (state === "behind") {
        await seedCopy(db, engine, cluster, at);
        await say(
          db,
          `Made the standby copy of ${db.name} on ${await nameOf(at)} again: it had stopped following`,
        );
      } else if (state && db.standbySeed) {
        // A database that restarted may have forgotten what lets its copy in; preparing it twice changes nothing.
        if (state !== "following")
          await run(db, db.serverId, db.host, engine.prepare(argsOf(db))).catch(
            quietly(db.host),
          );
        // Same seed, so the data stays: only what changed on the database (memory, version, network) reaches the copy.
        const yaml = copyYaml(db, engine, db.standbySeed);
        await onServer(at, async (conn) => {
          const cur = await conn.readStack(db.host);
          if (cur.exists && cur.yaml !== yaml)
            await conn.reroute(rerouteRequest(db, yaml));
        }).catch(quietly(db.host));
      }
      return;
    }
    try {
      const member = await placeCopy(db, engine, cluster);
      await seedCopy(db, engine, cluster, member);
      await say(
        db,
        `Keeps a standby copy of ${db.name} on ${await nameOf(member)}`,
      );
    } catch (e) {
      await tellCluster(db, cluster);
      await recordOnce(
        db,
        `${db.name} has no standby copy right now. ${e instanceof Error ? e.message : String(e)}`,
        "database",
      );
    }
  });
}

const inFlight = new Set<Promise<void>>();

/** Off the caller's lane, after a failover or a move; it never throws. */
export function syncStandbySoon(id: string): void {
  const p: Promise<void> = syncStandby(id)
    .catch(quietly(id))
    .finally(() => void inFlight.delete(p));
  inFlight.add(p);
}

/** Resolves once every sync started that way has settled. */
export async function flushStandbySyncs(): Promise<void> {
  while (inFlight.size > 0) await Promise.all([...inFlight]);
}

/** The database left its cluster: the switch goes off with the copy, and its own server stops keeping changes for one. */
export async function endStandby(id: string): Promise<void> {
  const db = await loadForDeplo(id);
  if (!db?.standby) return;
  await getDb()
    .update(databasesTable)
    .set({ standby: false, standbySeed: null })
    .where(eq(databasesTable.id, id));
  await dropStandbyCopy(db);
  const engine = STANDBY_ENGINES[db.type];
  if (engine && db.status === "running")
    await run(db, db.serverId, db.host, engine.retire(argsOf(db))).catch(
      quietly(db.host),
    );
  await applySettings(db, engine).catch(quietly(db.host));
}

/** A cluster lost a server: its standby copies are looked at now, not at the next sweep. */
export async function syncClusterStandbys(clusterId: string): Promise<void> {
  const rows = await getDb()
    .select({ id: databasesTable.id })
    .from(databasesTable)
    .where(
      and(
        eq(databasesTable.clusterId, clusterId),
        eq(databasesTable.standby, true),
      ),
    );
  for (const r of rows) syncStandbySoon(r.id);
}

/** The sweep's job: every database that asks for a standby copy has one that follows it, and no other has any. */
export async function reconcileStandbys(): Promise<void> {
  if (await instanceFrozen()) return;
  const rows = await getDb()
    .select({ id: databasesTable.id })
    .from(databasesTable)
    .where(
      and(
        isNotNull(databasesTable.clusterId),
        eq(databasesTable.standby, true),
      ),
    );
  for (const r of rows) await syncStandby(r.id).catch(quietly(r.id));
}

export interface DatabaseStandby {
  enabled: boolean;
  /** Why the switch cannot be turned on as the database is now; null when it can. */
  unavailable: string | null;
  /** What it costs, as the switch states it. */
  cost: string;
  /** The server holding the copy, or null when there is none right now. */
  serverName: string | null;
  /** One line under the switch while it is on. */
  note: string | null;
}

/** What the Advanced page shows for the switch. */
export async function getDatabaseStandby(
  id: string,
): Promise<DatabaseStandby | null> {
  const db = await loadDatabase(id, await requireActiveTeamId(), {
    forRead: true,
  });
  if (!db) return null;
  const at = db.standby ? await standbyMemberOf(id) : null;
  const serverName = at && at !== db.serverId ? await nameOf(at) : null;
  const engine = STANDBY_ENGINES[db.type];
  const cluster = db.clusterId ? await getClusterById(db.clusterId) : null;
  const small = engine && cluster ? await tooSmall(db, engine, cluster) : null;
  return {
    enabled: Boolean(db.standby),
    unavailable:
      standbySupport(db) ??
      (cluster
        ? small
        : "A standby copy runs on another server of a cluster. Place the database on a cluster first."),
    cost: standbyCost(db),
    serverName,
    note: !db.standby
      ? null
      : serverName
        ? `The copy runs on ${serverName}. A failover promotes it.`
        : small
          ? `There is no standby copy right now. ${small}`
          : "There is no standby copy right now. Deplo makes one as soon as another server has room.",
  };
}
