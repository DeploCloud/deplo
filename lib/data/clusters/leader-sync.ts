import "server-only";

import { and, eq, gte, inArray, ne } from "drizzle-orm";
import { getDb } from "../../db/client";
import { activities } from "../../db/schema/control-plane/activity";
import {
  appVolumes,
  apps as appsTable,
} from "../../db/schema/control-plane/apps";
import {
  clusterMembers as membersTable,
  clusters as clustersTable,
  workloadPlacements,
} from "../../db/schema/control-plane/clusters";
import { databases as databasesTable } from "../../db/schema/control-plane/databases";
import { servers as serversTable } from "../../db/schema/control-plane/servers";
import { nowIso } from "../../ids";
import {
  callClusterLeader,
  memberTakesOver,
} from "../../infra/agent-client/cluster-host";
import { clusterFailoverUnsupportedMessage } from "../../infra/agent-client/errors";
import type { Cluster, ClusterLeaseState } from "../../types/cluster";
import { recordActivity } from "../activity";
import { clusterMemberFacts } from "./facts";
import { leaderHost } from "./host";
import { fingerprintOf } from "./relay";
import { clusterMemberServerIds } from "./roster";

// What the control plane tells its cluster's leader, and what it reads back to reconcile (spec #176).
// Internal: the callers hold the gates.

const enc = (v: unknown): Uint8Array =>
  new TextEncoder().encode(JSON.stringify(v));

export interface LeaderEntry {
  kind: "app" | "database";
  id: string;
  replica: number;
  member: string;
  slug: string;
  /** A database, or an App with a Volume: stopped first when a member's lease runs out. */
  singleWriter: boolean;
}

/** The mirror of the leader's placement, with the stack name and whether the workload is single-writer. */
export async function placementEntries(
  clusterId: string,
): Promise<LeaderEntry[]> {
  const db = getDb();
  const [apps, dbs] = await Promise.all([
    db
      .select({ id: appsTable.id, slug: appsTable.slug })
      .from(appsTable)
      .where(eq(appsTable.clusterId, clusterId)),
    db
      .select({ id: databasesTable.id, host: databasesTable.host })
      .from(databasesTable)
      .where(eq(databasesTable.clusterId, clusterId)),
  ]);
  const ids = [...apps.map((a) => a.id), ...dbs.map((d) => d.id)];
  if (ids.length === 0) return [];
  const rows = await db
    .select()
    .from(workloadPlacements)
    .where(inArray(workloadPlacements.workloadId, ids));
  const volumes = apps.length
    ? await db
        .select({ appId: appVolumes.appId })
        .from(appVolumes)
        .where(
          and(
            inArray(
              appVolumes.appId,
              apps.map((a) => a.id),
            ),
            ne(appVolumes.type, "host"),
          ),
        )
    : [];
  const withVolume = new Set(volumes.map((v) => v.appId));
  const slugOf = new Map<string, string>([
    ...apps.map((a) => [a.id, a.slug] as const),
    ...dbs.map((d) => [d.id, d.host] as const),
  ]);
  const out: LeaderEntry[] = [];
  for (const r of rows) {
    const kind = r.kind === "database" ? "database" : "app";
    out.push({
      kind,
      id: r.workloadId,
      replica: r.replica,
      // Empty is waiting for room: the leader keeps trying only what the roster still names.
      member: r.memberServerId ?? "",
      slug: slugOf.get(r.workloadId) ?? "",
      singleWriter: kind === "database" || withVolume.has(r.workloadId),
    });
  }
  return out.sort((a, b) =>
    `${a.kind}/${a.id}/${a.replica}`.localeCompare(
      `${b.kind}/${b.id}/${b.replica}`,
    ),
  );
}

/** One replica the leader moved, or left waiting (`member` empty), that no roster has repeated yet. */
export interface LeaderMove extends LeaderEntry {
  from: string;
  reason: string;
  /** The leader's event that reported it. */
  seq: number;
}

export interface LeaderSnapshot {
  head: number;
  clusters: Record<
    string,
    {
      epoch: number;
      superseded: boolean;
      members: { id: string; state: string }[];
      placement?: LeaderEntry[];
      moves?: LeaderMove[];
    }
  >;
}

export async function readLeaderSnapshot(
  cluster: Cluster,
): Promise<LeaderSnapshot | null> {
  const host = await leaderHost(cluster);
  if (!host) return null;
  const raw = await callClusterLeader(host.id, "leader.snapshot", enc({}));
  return JSON.parse(new TextDecoder().decode(raw)) as LeaderSnapshot;
}

/** Says once a day which member cannot take over, so the gap is read in Activity and not found in a failover. */
async function nameOldAgent(cluster: Cluster, serverId: string): Promise<void> {
  const [server] = await getDb()
    .select({ name: serversTable.name })
    .from(serversTable)
    .where(eq(serversTable.id, serverId))
    .limit(1);
  if (!server) return;
  const message = clusterFailoverUnsupportedMessage(server.name, cluster.name);
  const since = new Date(Date.now() - 24 * 3_600_000).toISOString();
  const seen = await getDb()
    .select({ id: activities.id })
    .from(activities)
    .where(
      and(eq(activities.message, message), gte(activities.createdAt, since)),
    )
    .limit(1);
  if (seen.length === 0) await recordActivity("server", message, "Deplo");
}

const pushed = new Map<string, string>();

/** Forgets what was last sent, so the next push goes out whatever changed (a leader that restarted). */
export function forgetLeaderRoster(clusterId?: string): void {
  if (clusterId) pushed.delete(clusterId);
  else pushed.clear();
}

/**
 * Tells the leader who is in the cluster, at which epoch, and where everything runs. A leader on a newer epoch is
 * adopted, not fought. With `onlyIfChanged` nothing is sent when it would repeat the last push.
 */
export async function pushLeaderRoster(
  cluster: Cluster,
  opts: { onlyIfChanged?: boolean } = {},
): Promise<boolean> {
  const host = await leaderHost(cluster);
  if (!host) return false;
  const members: Record<string, unknown>[] = [];
  const facts = new Map(
    (await clusterMemberFacts(cluster.id)).map((f) => [f.id, f]),
  );
  for (const id of await clusterMemberServerIds(cluster.id)) {
    const fingerprint = await fingerprintOf(id);
    // A member that has not enrolled has no certificate to be reached by yet.
    if (!fingerprint) continue;
    const f = facts.get(id);
    const tooOld = !(await memberTakesOver(id));
    if (tooOld) await nameOldAgent(cluster, id);
    // The facts ride along so the leader can place work while Deplo is away.
    members.push({
      id,
      fingerprint,
      arch: f?.arch ?? "",
      freeMb: f?.freeMb ?? 0,
      images: f?.images ?? [],
      emptying: f?.emptying ?? false,
      databaseEnvs: f?.databaseEnvs ?? [],
      // The leader never hands a moved workload to an agent that would not start it.
      ...(tooOld ? { noFailover: true } : {}),
    });
  }
  const placement = await placementEntries(cluster.id);
  const body = (epoch: number) =>
    callClusterLeader(
      host.id,
      "leader.roster",
      enc({ cluster: cluster.id, epoch, members, placement }),
    );
  const epoch = Math.max(cluster.leaderEpoch, 1);
  const signature = JSON.stringify({ epoch, members, placement });
  if (opts.onlyIfChanged && pushed.get(cluster.id) === signature) return false;
  try {
    await body(epoch);
    pushed.set(cluster.id, signature);
    return true;
  } catch (e) {
    const snap = await readLeaderSnapshot(cluster).catch(() => null);
    const held = snap?.clusters[cluster.id]?.epoch ?? 0;
    if (held <= epoch) throw e;
    await getDb()
      .update(clustersTable)
      .set({ leaderEpoch: held })
      .where(eq(clustersTable.id, cluster.id));
    await body(held);
    pushed.delete(cluster.id);
    return true;
  }
}

/** Records what the leader said about one member's lease; returns whether it changed. */
export async function setMemberLease(
  clusterId: string,
  serverId: string,
  state: ClusterLeaseState,
): Promise<boolean> {
  const rows = await getDb()
    .update(membersTable)
    .set({ leaseState: state, leaseChangedAt: nowIso() })
    .where(
      and(
        eq(membersTable.serverId, serverId),
        eq(membersTable.clusterId, clusterId),
        ne(membersTable.leaseState, state),
      ),
    )
    .returning({ serverId: membersTable.serverId });
  return rows.length > 0;
}
