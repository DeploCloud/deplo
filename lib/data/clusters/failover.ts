import "server-only";

import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "../../db/client";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import { dispatchAlert } from "../../notify/dispatch";
import type { Cluster } from "../../types/cluster";
import { recordActivity } from "../activity";
import { getServerById } from "../servers/roster";
import { rehostClusterApp } from "./failover-address";
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

/** One App has run on its new member: say so, and give a generated address its new host. */
export async function applyFailedOver(
  cluster: Cluster,
  d: Record<string, unknown>,
): Promise<void> {
  if (d.kind !== "app" || typeof d.workloadId !== "string") return;
  if (typeof d.from !== "string" || typeof d.to !== "string") return;
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

/** The end of one failover: an Activity line for each App left waiting, and one alert per team that has some. */
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
        .filter((w) => w.kind === "app" && w.workloadId)
    : [];
  if (left.length === 0 || typeof d.member !== "string") return;
  const rows = await getDb()
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
        inArray(
          appsTable.id,
          left.map((w) => w.workloadId),
        ),
      ),
    );
  if (rows.length === 0) return;
  const from = await serverName(d.member);
  const byTeam = new Map<string, typeof rows>();
  for (const r of rows) {
    await recordActivity(
      "app",
      `${r.name} is waiting for room in ${cluster.name}: ${from} stopped answering and no other server has room yet`,
      ACTOR,
      r.id,
      r.teamId,
    );
    byTeam.set(r.teamId, [...(byTeam.get(r.teamId) ?? []), r]);
  }
  for (const [teamId, apps] of byTeam) {
    const names = apps.map((a) => a.name).join(", ");
    dispatchAlert({
      teamId,
      key: "cluster_failover_waiting",
      dedupe: { id: `failover:${cluster.id}:${seq}`, state: "waiting" },
      title: `${apps.length === 1 ? names : `${apps.length} Apps`} waiting for room in ${cluster.name}`,
      body: `${from} stopped answering. ${names} found no room on the other servers yet. Deplo tries again every 30 seconds.`,
      path: apps.length === 1 ? `/apps/${apps[0]!.slug}` : undefined,
      appId: apps.length === 1 ? apps[0]!.id : null,
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
  const moves = (view.moves ?? []).filter(
    (m) => (m.kind === "app" || m.kind === "database") && m.id,
  );
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
