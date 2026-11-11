import "server-only";

import { eq } from "drizzle-orm";

import { getDb } from "../../db/client";
import { databases as databasesTable } from "../../db/schema/control-plane/databases";
import { getCurrentUser } from "../../auth/current-user";
import { requireCapability, canExposePorts } from "../../membership";
import { recordActivity } from "../activity";
import { markLinkedAppsPending } from "../database-links";
import { encryptSecret } from "../../crypto";
import { connectAgent } from "../../infra/agent-client/connect";
import { buildConnectionString } from "../../deploy/database-compose";
import {
  migrateWorkloadData,
  stopStackOn,
  startStackOn,
  destroyStackOn,
} from "../volume-migration";
import { withKeyedLock } from "../keyed-mutex";
import { getServerById } from "../servers/roster";
import { databaseHostClash, hostNameClaims } from "../host-name-claims";
import { publishDatabaseChanged } from "../../graphql/pubsub";
import {
  MIN_USER_PORT,
  MAX_PORT,
  isValidExposePort,
} from "../../databases/ports";
import { assembleDatabase } from "../backup-rows";
import { assertNotMigrating } from "../migration-guard";
import type { Database } from "../../types/database";
import { assertNotProvisioning, mountsFor, requireDatabase } from "./rows";
import {
  databasePassword,
  dbVolumeHostName,
  renderDatabaseStackYaml,
  rerouteRequest,
} from "./stack";
import { assertServerNotInCluster } from "../clusters/members";
import {
  askLeaderToPlace,
  clearPlacement,
  recordPlacement,
} from "../clusters/placement";
import { listClustersForTeam } from "../clusters/roster";
import { ensureFailoverBackup } from "./failover";
import { assertHostPortAvailable, resolveTeamServer } from "./server-ports";
import type { Cluster } from "../../types/cluster";

interface UpdateDatabaseInput {
  exposedPublicly: boolean;
  exposedPort?: number;
  serverId?: string;
}

export function updateDatabase(
  id: string,
  input: UpdateDatabaseInput,
): Promise<void> {
  return writeDatabasePlacement(id, input);
}

/** Places a database on a cluster: the leader picks the member, the database moves there like a server move. */
export async function moveDatabaseToCluster(
  id: string,
  clusterId: string,
): Promise<void> {
  const { membership } = await requireCapability("configure_databases");
  const cluster = (await listClustersForTeam(membership.teamId)).find(
    (c) => c.id === clusterId,
  );
  if (!cluster) throw new Error("That cluster isn't available to this team.");
  const db = await requireDatabase(id, membership.teamId);
  if (db.clusterId === cluster.id) return;
  assertNotProvisioning(db, "moving it");
  // A refusal throws here, before anything stops.
  const member = await askLeaderToPlace(cluster, {
    kind: "database",
    id,
    name: db.name,
    environmentId: db.environmentId,
    limitMb: db.resources?.memoryMb ?? 0,
  });
  await writeDatabasePlacement(
    id,
    {
      exposedPublicly: db.exposedPublicly,
      exposedPort: db.exposedPort ?? undefined,
      serverId: member,
    },
    cluster,
  );
  await recordPlacement({
    clusterId: cluster.id,
    kind: "database",
    workloadId: id,
    members: [member],
    epoch: cluster.leaderEpoch,
  });
  await ensureFailoverBackup({
    ...db,
    serverId: member,
    clusterId: cluster.id,
  });
}

async function writeDatabasePlacement(
  id: string,
  input: UpdateDatabaseInput,
  cluster?: Cluster,
  as?: { teamId: string; why: string },
): Promise<void> {
  const teamId =
    as?.teamId ??
    (await requireCapability("configure_databases")).membership.teamId;
  const actor = as ? "Deplo" : (await getCurrentUser())!.name;
  const load = () => (as ? loadForDeplo(id) : requireDatabase(id, teamId));
  const db = await load();

  const exposed = input.exposedPublicly;
  if (exposed && !as && !(await canExposePorts()))
    throw new Error("You don't have permission to publish ports");

  // The cluster is shared with the team even when the member it lands on is not.
  const targetServer = as
    ? await getServerById(input.serverId!)
    : await resolveTeamServer(teamId, input.serverId ?? db.serverId);
  if (!targetServer) throw new Error("Server not found");
  const movingFrom = targetServer.id !== db.serverId ? db.serverId : null;
  if (movingFrom && !cluster) await assertServerNotInCluster(targetServer.id);
  if (movingFrom) {
    const clash = databaseHostClash(
      db.host,
      targetServer,
      await hostNameClaims(),
    );
    if (clash)
      throw new Error(
        `${db.name} cannot move to ${targetServer.name}: ${clash}.`,
      );
  }

  let newExposedPort: number | null = null;
  if (exposed) {
    if (input.exposedPort == null)
      throw new Error(
        "A host port is required to expose the database publicly",
      );
    if (!isValidExposePort(input.exposedPort))
      throw new Error(
        `Port ${input.exposedPort} is invalid - choose an unprivileged port (${MIN_USER_PORT}-${MAX_PORT})`,
      );
    const reusingOwnPort =
      !movingFrom && db.exposedPublicly && db.exposedPort === input.exposedPort;
    if (!reusingOwnPort)
      await assertHostPortAvailable(targetServer, input.exposedPort, db.id);
    newExposedPort = input.exposedPort;
  }

  if (
    !movingFrom &&
    db.exposedPublicly === exposed &&
    db.exposedPort === newExposedPort
  )
    return;

  let moveWarning: string | null = null;
  await withKeyedLock(id, async () => {
    const cur = await load();
    assertNotProvisioning(cur, "editing it");
    const password = databasePassword(cur);
    const connEnc = encryptSecret(
      buildConnectionString({
        type: cur.type,
        username: cur.username,
        password,
        host: newExposedPort != null ? targetServer.host : cur.host,
        port: newExposedPort != null ? newExposedPort : cur.port,
        dbName: cur.dbName,
      }),
    );
    const yaml = renderDatabaseStackYaml(
      { ...cur, exposedPublicly: exposed, exposedPort: newExposedPort },
      password,
    );
    const agent = await connectAgent(targetServer.id);
    try {
      const res = await agent.reroute(rerouteRequest(cur, yaml));
      if (!res.ok)
        throw new Error(res.error || "agent failed to update the database");
    } finally {
      agent.close();
    }

    if (movingFrom) {
      await stopStackOn(targetServer.id, cur.host);
      await stopStackOn(movingFrom, cur.host);
      try {
        const moved = await migrateWorkloadData(movingFrom, targetServer.id, {
          volumeNames: [dbVolumeHostName(cur.host)],
        });
        // A wrong volume name lands nothing rather than failing, so refuse before the old host is torn down.
        if (moved.missing.length > 0)
          throw new Error(
            `${moved.missing.join(", ")} is not on that server, so there was nothing to move`,
          );
      } catch (copyErr) {
        await destroyStackOn(targetServer.id, cur.host).catch(() => {});
        await startStackOn(movingFrom, cur.host).catch(() => {});
        throw new Error(
          `Failed to copy ${cur.name}'s data to ${targetServer.name}: ` +
            `${copyErr instanceof Error ? copyErr.message : String(copyErr)}. ` +
            `The move was rolled back - the database is still on its original server.`,
        );
      }
      try {
        await startStackOn(targetServer.id, cur.host);
      } catch (e) {
        moveWarning =
          `Moved ${cur.name}'s data to ${targetServer.name}, but its stack did not ` +
          `start there (${e instanceof Error ? e.message : String(e)}). ` +
          `Redeploy the database to bring it up.`;
      }

      try {
        const old = await connectAgent(movingFrom);
        try {
          // Only reached once the copy landed: this destroys the OLD data volume too.
          const r = await old.destroyStack(cur.host, true);
          if (!r.ok)
            moveWarning =
              `Moved ${cur.name} to ${targetServer.name}, but the old server did ` +
              `not cleanly tear down ${cur.host} (${r.error || "unknown error"}). ` +
              `Its old container/volume may need a manual sweep on that host.`;
        } finally {
          old.close();
        }
      } catch (e) {
        moveWarning =
          `Moved ${cur.name} to ${targetServer.name}, but the old server was ` +
          `unreachable to tear down ${cur.host} ` +
          `(${e instanceof Error ? e.message : String(e)}). Its old container/` +
          `volume may need a manual sweep on that host.`;
      }
    }

    await getDb()
      .update(databasesTable)
      .set({
        serverId: targetServer.id,
        ...(movingFrom ? { clusterId: cluster?.id ?? null } : {}),
        exposedPublicly: exposed,
        exposedPort: newExposedPort,
        connectionStringEnc: connEnc,
      })
      .where(eq(databasesTable.id, id));
    publishDatabaseChanged(id);
  });
  if (moveWarning) console.warn(`[databases] ${moveWarning}`);
  if (movingFrom && db.clusterId && !cluster)
    await clearPlacement("database", id);
  // A move inside the cluster names the server only; arriving on it names both.
  const where =
    cluster && db.clusterId !== cluster.id
      ? `cluster ${cluster.name}, now on ${targetServer.name}`
      : targetServer.name;
  await recordActivity(
    "database",
    movingFrom
      ? moveWarning
        ? `Moved database ${db.name} to ${where} (warning: ${moveWarning})`
        : `Moved database ${db.name} to ${where}` + (as ? `: ${as.why}` : "")
      : exposed
        ? `Exposed database ${db.name} on port ${newExposedPort}`
        : `Unexposed database ${db.name}`,
    actor,
    null,
    teamId,
    null,
    db.id,
  );
  await markLinkedAppsPending(db.id);
}

/**
 * Deplo itself moving a cluster database to another member of its cluster, as emptying a server does.
 * No Capability is read: the caller holds the gate. The database stays on the cluster.
 */
export async function relocateClusterDatabase(
  id: string,
  cluster: Cluster,
  serverId: string,
  why: string,
): Promise<void> {
  const [row] = await getDb()
    .select({
      teamId: databasesTable.teamId,
      clusterId: databasesTable.clusterId,
      exposedPublicly: databasesTable.exposedPublicly,
      exposedPort: databasesTable.exposedPort,
    })
    .from(databasesTable)
    .where(eq(databasesTable.id, id))
    .limit(1);
  if (!row || row.clusterId !== cluster.id)
    throw new Error("Database not found");
  await writeDatabasePlacement(
    id,
    {
      exposedPublicly: row.exposedPublicly,
      exposedPort: row.exposedPort ?? undefined,
      serverId,
    },
    cluster,
    { teamId: row.teamId, why },
  );
}

// Deplo acting for itself has no session, which the team-scoped loader requires.
async function loadForDeplo(id: string): Promise<Database> {
  const [row] = await getDb()
    .select()
    .from(databasesTable)
    .where(eq(databasesTable.id, id))
    .limit(1);
  if (!row) throw new Error("Not found");
  assertNotMigrating("database", row.name, row.migrationRunId);
  return assembleDatabase(row, await mountsFor(row.id));
}
