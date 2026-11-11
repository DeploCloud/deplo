import "server-only";

import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "../../db/client";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import {
  backupRuns as runsTable,
  backups as backupsTable,
} from "../../db/schema/control-plane/backups";
import { databases as databasesTable } from "../../db/schema/control-plane/databases";
import { encryptSecret } from "../../crypto";
import {
  promotedSentence,
  restoredSentence,
} from "../../databases/failover-copy";
import { buildConnectionString } from "../../deploy/database-compose";
import { publishDatabaseChanged } from "../../graphql/pubsub";
import { dispatchAlert } from "../../notify/dispatch";
import type { Cluster } from "../../types/cluster";
import { recordActivity } from "../activity";
import { assembleDatabase } from "../backup-rows";
import { markLinkedAppsPending } from "../database-links";
import { syncStandbySoon } from "../databases/standby";
import { databasePassword } from "../databases/stack";
import { getServerById } from "../servers/roster";
import { pushDatabaseBundle } from "./database-bundles";
import { rehostClusterApp } from "./failover-address";
import { syncNameForwarders } from "./forwarders";
import type { LeaderEntry, LeaderMove } from "./leader-sync";
import { listWorkloadPlacements, recordPlacement } from "./placement";

// What the control plane does with a failover the leader reports (spec #176): words for the user, a new address
// for an App on a generated one, and one alert when something is left waiting. The leader has already moved it.
// https://deplo.build/docs/operations/clusters#when-a-server-stops

const ACTOR = "Deplo";

const REASONS: Record<string, string> = {
  stopped_answering: "stopped answering",
};

async function serverName(id: string): Promise<string> {
  return (await getServerById(id))?.name ?? "A server";
}

async function ownApp(clusterId: string, id: string) {
  const [app] = await getDb()
    .select({
      id: appsTable.id,
      name: appsTable.name,
      teamId: appsTable.teamId,
      slug: appsTable.slug,
    })
    .from(appsTable)
    .where(and(eq(appsTable.id, id), eq(appsTable.clusterId, clusterId)))
    .limit(1);
  return app ?? null;
}

const quietly = (what: string) => (e: unknown) =>
  console.warn(
    `[cluster-failover] ${what}: ${e instanceof Error ? e.message : String(e)}`,
  );

/**
 * One database was restored on its new member: say from which backup, point a published address at the new
 * server, hand the leader a bundle for where it runs now, and move its name on the other members (#202).
 */
async function databaseFailedOver(
  cluster: Cluster,
  d: {
    workloadId: string;
    from: string;
    to: string;
    backupId?: unknown;
    backupAt?: unknown;
    promoted?: unknown;
  },
): Promise<void> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(databasesTable)
    .where(
      and(
        eq(databasesTable.id, d.workloadId),
        eq(databasesTable.clusterId, cluster.id),
      ),
    )
    .limit(1);
  if (!row) return;
  const target = await getServerById(d.to);
  // The backup is read from this database's own runs; the event's time is only what is left when it is gone.
  const [run] =
    typeof d.backupId === "string"
      ? await db
          .select({
            startedAt: runsTable.startedAt,
            timezone: backupsTable.timezone,
          })
          .from(runsTable)
          .leftJoin(backupsTable, eq(backupsTable.id, runsTable.backupId))
          .where(
            and(
              eq(runsTable.id, d.backupId),
              eq(runsTable.teamId, row.teamId),
              eq(runsTable.targetId, row.id),
            ),
          )
          .limit(1)
      : [];
  await recordActivity(
    "database",
    d.promoted === true
      ? promotedSentence(
          row.name,
          target?.name ?? "another server",
          await serverName(d.from),
        )
      : restoredSentence(
          row.name,
          target?.name ?? "another server",
          run?.startedAt ??
            (typeof d.backupAt === "string" ? d.backupAt : null),
          run?.timezone ?? "UTC",
        ),
    ACTOR,
    null,
    row.teamId,
    null,
    row.id,
  );
  if (target && row.exposedPublicly && row.exposedPort != null) {
    // A published database is reached on its server's own address, which just changed.
    const cur = assembleDatabase(row);
    await db
      .update(databasesTable)
      .set({
        connectionStringEnc: encryptSecret(
          buildConnectionString({
            type: cur.type,
            username: cur.username,
            password: databasePassword(cur),
            host: target.host,
            port: row.exposedPort,
            dbName: cur.dbName,
          }),
        ),
      })
      .where(eq(databasesTable.id, row.id));
    await markLinkedAppsPending(row.id).catch(quietly(row.id));
  }
  publishDatabaseChanged(row.id);
  await pushDatabaseBundle(row.id).catch(quietly(row.id));
  await syncNameForwarders(cluster.id).catch(quietly(cluster.id));
  // A promoted copy is the database now: another server gets a new one when there is one.
  if (row.standby) syncStandbySoon(row.id);
}

/** One workload has run on its new member: say so, and give an App's generated address its new host. */
export async function applyFailedOver(
  cluster: Cluster,
  d: Record<string, unknown>,
): Promise<void> {
  if (typeof d.workloadId !== "string") return;
  if (typeof d.from !== "string" || typeof d.to !== "string") return;
  if (d.kind === "database")
    return databaseFailedOver(cluster, {
      workloadId: d.workloadId,
      from: d.from,
      to: d.to,
      backupId: d.backupId,
      backupAt: d.backupAt,
      promoted: d.promoted,
    });
  if (d.kind !== "app") return;
  const app = await ownApp(cluster.id, d.workloadId);
  if (!app) return;
  const why = REASONS[String(d.reason)] ?? "stopped answering";
  const [from, to] = await Promise.all([serverName(d.from), serverName(d.to)]);
  await recordActivity(
    "app",
    `Moved ${app.name} to ${to}: ${from} ${why}`,
    ACTOR,
    app.id,
    app.teamId,
  );
  try {
    await rehostClusterApp(app.id);
  } catch (e) {
    // The sweep tries again; until then the App runs but its generated address still names the old server.
    await recordActivity(
      "app",
      `${app.name} runs on ${to}, but its generated address could not be updated yet: ${e instanceof Error ? e.message : String(e)}`,
      ACTOR,
      app.id,
      app.teamId,
    );
  }
}

interface Left {
  kind: string;
  workloadId: string;
}

/** The end of one failover: an Activity line for each App or database left waiting, and one alert per team that has some. */
export async function applyFailoverSummary(
  cluster: Cluster,
  seq: number,
  d: Record<string, unknown>,
): Promise<void> {
  const left: Left[] = Array.isArray(d.waiting)
    ? d.waiting
        .filter(
          (w): w is Record<string, unknown> =>
            Boolean(w) && typeof w === "object",
        )
        .map((w) => ({
          kind: String(w.kind),
          workloadId: String(w.workloadId),
        }))
        .filter((w) => w.workloadId)
    : [];
  if (left.length === 0 || typeof d.member !== "string") return;
  const idsOf = (kind: string) =>
    left.filter((w) => w.kind === kind).map((w) => w.workloadId);
  const db = getDb();
  const [apps, dbs] = await Promise.all([
    idsOf("app").length === 0
      ? []
      : db
          .select({
            id: appsTable.id,
            name: appsTable.name,
            teamId: appsTable.teamId,
            slug: appsTable.slug,
          })
          .from(appsTable)
          .where(
            and(
              eq(appsTable.clusterId, cluster.id),
              inArray(appsTable.id, idsOf("app")),
            ),
          ),
    idsOf("database").length === 0
      ? []
      : db
          .select({
            id: databasesTable.id,
            name: databasesTable.name,
            teamId: databasesTable.teamId,
          })
          .from(databasesTable)
          .where(
            and(
              eq(databasesTable.clusterId, cluster.id),
              inArray(databasesTable.id, idsOf("database")),
            ),
          ),
  ]);
  // Databases first, as the leader tried them.
  const rows = [
    ...dbs.map((r) => ({ ...r, kind: "database" as const, slug: "" })),
    ...apps.map((r) => ({ ...r, kind: "app" as const })),
  ];
  if (rows.length === 0) return;
  const from = await serverName(d.member);
  const byTeam = new Map<string, typeof rows>();
  for (const r of rows) {
    await recordActivity(
      r.kind,
      `${r.name} is waiting for room in ${cluster.name}: ${from} stopped answering and no other server has room yet`,
      ACTOR,
      r.kind === "app" ? r.id : null,
      r.teamId,
      null,
      r.kind === "database" ? r.id : null,
    );
    byTeam.set(r.teamId, [...(byTeam.get(r.teamId) ?? []), r]);
  }
  for (const [teamId, waiting] of byTeam) {
    const names = waiting.map((a) => a.name).join(", ");
    const only = waiting.length === 1 ? waiting[0]! : null;
    const many = waiting.every((w) => w.kind === "app")
      ? `${waiting.length} Apps`
      : `${waiting.length} Apps and databases`;
    dispatchAlert({
      teamId,
      key: "cluster_failover_waiting",
      dedupe: { id: `failover:${cluster.id}:${seq}`, state: "waiting" },
      title: `${only ? names : many} waiting for room in ${cluster.name}`,
      body: `${from} stopped answering. ${names} found no room on the other servers yet. Deplo tries again every 30 seconds.`,
      path: !only
        ? undefined
        : only.kind === "app"
          ? `/apps/${only.slug}`
          : "/storage",
      appId: only?.kind === "app" ? only.id : null,
    });
  }
}

/**
 * After a reconnect: what the leader moved on its own becomes the mirror, before any roster goes back to it.
 * A move whose event fell in `lost` (the watch said events were dropped) also gets its words, address and alert.
 */
export async function adoptLeaderMoves(
  cluster: Cluster,
  view: { epoch: number; placement?: LeaderEntry[]; moves?: LeaderMove[] },
  lost: { after: number; before: number } | null,
): Promise<void> {
  // In the order the leader made them: a database was restored before any App started.
  const moves = (view.moves ?? [])
    .filter((m) => (m.kind === "app" || m.kind === "database") && m.id)
    .sort((a, b) => a.seq - b.seq);
  const waiting = new Map<string, { seq: number; left: Left[] }>();
  for (const key of new Set(moves.map((m) => `${m.kind}/${m.id}`))) {
    const [kind, id] = key.split("/") as ["app" | "database", string];
    const members = (view.placement ?? [])
      .filter((e) => e.kind === kind && e.id === id)
      .sort((a, b) => a.replica - b.replica)
      .map((e) => e.member || null);
    if (members.length === 0) continue;
    const mirror = (await listWorkloadPlacements(kind, [id])).get(id) ?? [];
    if (mirror.map((p) => p.serverId).join() !== members.join())
      try {
        await recordPlacement({
          clusterId: cluster.id,
          kind,
          workloadId: id,
          members,
          epoch: view.epoch || cluster.leaderEpoch,
        });
      } catch (e) {
        console.warn(
          `[cluster-watch] ${cluster.id}: ${e instanceof Error ? e.message : String(e)}`,
        );
        continue;
      }
    for (const m of moves) {
      if (m.kind !== kind || m.id !== id) continue;
      if (!lost || m.seq <= lost.after || m.seq >= lost.before) continue;
      if (m.member)
        await applyFailedOver(cluster, {
          kind,
          workloadId: id,
          from: m.from,
          to: m.member,
          reason: m.reason,
          backupId: m.backupId,
          backupAt: m.backupAt,
          promoted: m.promoted,
        });
      else {
        const w = waiting.get(m.from) ?? { seq: 0, left: [] };
        if (!w.left.some((l) => l.workloadId === id))
          w.left.push({ kind, workloadId: id });
        w.seq = Math.max(w.seq, m.seq);
        waiting.set(m.from, w);
      }
    }
  }
  for (const [member, w] of waiting)
    await applyFailoverSummary(cluster, w.seq, { member, waiting: w.left });
}
