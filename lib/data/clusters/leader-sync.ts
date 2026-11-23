import "server-only";

import { and, eq, gte, inArray, ne } from "drizzle-orm";
import { getDb } from "../../db/client";
import { activities } from "../../db/schema/control-plane/activity";
import {
  appMounts,
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
import { appKeepsVolume } from "../../apps/failover-copy";
import { declareServerDown } from "../../infra/agent-client/channel-pool";
import { nowIso } from "../../ids";
import {
  callClusterLeader,
  memberRestores,
  memberSucceeds,
  memberTakesOver,
} from "../../infra/agent-client/cluster-host";
import {
  clusterFailoverUnsupportedMessage,
  clusterRestoreUnsupportedMessage,
} from "../../infra/agent-client/errors";
import type { Cluster, ClusterLeaseState } from "../../types/cluster";
import { recordClusterActivity } from "./cluster-activity";
import { clusterMemberFacts } from "./facts";
import { listStandbys, recordPlacement } from "./placement";
import { leaderHost, leaderHostOf } from "./host";
import { clusterHeirs, clusterPreVotes } from "./succession";
import { fingerprintOf } from "./relay";
import { clusterMemberServerIds, getClusterById } from "./roster";
import { clusterRotations } from "./rotations";
import { getServerById } from "../servers/roster";
import { messageOf } from "../../utils";
import {
  AGENT_SHORT_FENCE_VERSION,
  reportedAgentVersion,
  versionAtLeast,
} from "../../version";

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
  /** An App the cluster load-balances: a server back from a failover gets its copy again. */
  balanced?: true;
}

/** The mirror of the leader's placement, with the stack name and whether the workload is single-writer. */
export async function placementEntries(
  clusterId: string,
): Promise<LeaderEntry[]> {
  const db = getDb();
  const [apps, dbs] = await Promise.all([
    db
      .select({
        id: appsTable.id,
        slug: appsTable.slug,
        compose: appsTable.compose,
      })
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
        .select({
          appId: appVolumes.appId,
          type: appVolumes.type,
          projectPath: appVolumes.projectPath,
        })
        .from(appVolumes)
        .where(
          inArray(
            appVolumes.appId,
            apps.map((a) => a.id),
          ),
        )
    : [];
  const mounts = apps.length
    ? await db
        .select({ appId: appMounts.appId, filePath: appMounts.filePath })
        .from(appMounts)
        .where(
          inArray(
            appMounts.appId,
            apps.map((a) => a.id),
          ),
        )
    : [];
  // The one rule of what keeps data: a Volume, a File only its server holds, or a stack's own volume. A Bind alone moves nowhere.
  const withVolume = new Set(
    apps
      .filter((a) =>
        appKeepsVolume({
          compose: a.compose,
          volumes: volumes.filter((v) => v.appId === a.id),
          mounts: mounts.filter((m) => m.appId === a.id),
        }),
      )
      .map((a) => a.id),
  );
  const balanced = await balancedApps(rows);
  const slugOf = new Map<string, string>([
    ...apps.map((a) => [a.id, a.slug] as const),
    ...dbs.map((d) => [d.id, d.host] as const),
  ]);
  const out: LeaderEntry[] = [];
  for (const r of rows) {
    // A standby copy is no replica: it goes to the leader on its own list.
    if (r.kind !== "app" && r.kind !== "database") continue;
    const kind = r.kind === "database" ? "database" : "app";
    out.push({
      kind,
      id: r.workloadId,
      replica: r.replica,
      // Empty is waiting for room: the leader keeps trying only what the roster still names.
      member: r.memberServerId ?? "",
      slug: slugOf.get(r.workloadId) ?? "",
      singleWriter: kind === "database" || withVolume.has(r.workloadId),
      ...(balanced.has(r.workloadId) ? { balanced: true as const } : {}),
    });
  }
  return out.sort((a, b) =>
    `${a.kind}/${a.id}/${a.replica}`.localeCompare(
      `${b.kind}/${b.id}/${b.replica}`,
    ),
  );
}

/** The Apps placed more than once that the cluster load-balances: only one of them can have a copy to give back. */
async function balancedApps(
  rows: { kind: string; workloadId: string }[],
): Promise<Set<string>> {
  const count = new Map<string, number>();
  for (const r of rows)
    if (r.kind === "app")
      count.set(r.workloadId, (count.get(r.workloadId) ?? 0) + 1);
  const { loadAppGraph } = await import("../app-graph-load");
  const { appLoadBalanced } = await import("./load-balancing");
  const out = new Set<string>();
  for (const [id, n] of count) {
    if (n < 2) continue;
    const app = await loadAppGraph(id);
    if (app && (await appLoadBalanced(app))) out.add(id);
  }
  return out;
}

/** One replica the leader moved, or left waiting (`member` empty), that no roster has repeated yet. */
export interface LeaderMove extends LeaderEntry {
  from: string;
  reason: string;
  /** The leader's event that reported it. */
  seq: number;
  /** Why a waiting replica found no member; an older leader does not say. */
  wait?: string;
  /** The backup a moved workload was restored from, when it was. */
  backupId?: string;
  backupAt?: string;
  /** How long the member took to start it and restore that backup. */
  restoreMs?: number;
  /** The workload's standby copy was promoted instead. */
  promoted?: boolean;
}

export interface LeaderSnapshot {
  head: number;
  clusters: Record<
    string,
    {
      epoch: number;
      superseded: boolean;
      /** heard: false is a member the leader has not heard since it took the epoch; an older leader omits it. */
      members: { id: string; state: string; heard?: boolean }[];
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
async function nameOldAgent(
  cluster: Cluster,
  serverId: string,
  sentence = clusterFailoverUnsupportedMessage,
): Promise<void> {
  const [server] = await getDb()
    .select({ name: serversTable.name })
    .from(serversTable)
    .where(eq(serversTable.id, serverId))
    .limit(1);
  if (!server) return;
  const message = sentence(server.name, cluster.name);
  const since = new Date(Date.now() - 24 * 3_600_000).toISOString();
  const seen = await getDb()
    .select({ id: activities.id })
    .from(activities)
    .where(
      and(eq(activities.message, message), gte(activities.createdAt, since)),
    )
    .limit(1);
  if (seen.length === 0) await recordClusterActivity(cluster.id, message);
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
  opts: { onlyIfChanged?: boolean; requireRotations?: boolean } = {},
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
    const agent = reportedAgentVersion((await getServerById(id)) ?? {});
    const tooOld = !(await memberTakesOver(id));
    if (tooOld) await nameOldAgent(cluster, id);
    const noRestore = !tooOld && !(await memberRestores(id));
    if (noRestore)
      await nameOldAgent(cluster, id, clusterRestoreUnsupportedMessage);
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
      // Nor a database to an agent that would start it empty.
      ...(noRestore ? { noRestore: true } : {}),
      // A leader that takes over waits less for a dead member whose agent stops its work on the short fence.
      ...(agent && versionAtLeast(agent, AGENT_SHORT_FENCE_VERSION)
        ? { shortFence: true }
        : {}),
      // Only an agent that answers a pre-vote is asked one: an older one would take the epoch.
      ...((await memberSucceeds(id)) ? { succession: true } : {}),
    });
  }
  const placement = await placementEntries(cluster.id);
  // A leader too old to know a standby copy ignores the list, and restores a backup as before.
  const standbys = (await listStandbys(cluster.id)).map((s) => ({
    kind: "database",
    id: s.databaseId,
    replica: 0,
    member: s.serverId,
    slug: s.host,
    singleWriter: false,
    standby: true,
  }));
  // A member named by its old certificate answers with its new one (ADR-0050); an older leader ignores them.
  const rotations = await clusterRotations(cluster.id);
  // The line: who leads after this leader, and Deplo's machine at its end. Standing in, it asks before it leads.
  const heirs = await clusterHeirs(cluster).catch(() => []);
  const deplo = (await leaderHostOf(null))?.id ?? "";
  const asks =
    !!cluster.leaderTakeoverAt &&
    (await clusterPreVotes(cluster.id).catch(() => false));
  const roster = {
    members,
    placement,
    ...(standbys.length > 0 ? { standbys } : {}),
    ...(rotations.length > 0 ? { rotations } : {}),
    self: host.id,
    deplo,
    heirs,
    ...(asks ? { succeed: true } : {}),
  };
  const body = (epoch: number) =>
    callClusterLeader(
      host.id,
      "leader.roster",
      enc({ cluster: cluster.id, epoch, ...roster }),
    );
  const epoch = Math.max(cluster.leaderEpoch, 1);
  const signature = JSON.stringify({ epoch, ...roster });
  if (
    opts.onlyIfChanged &&
    !opts.requireRotations &&
    pushed.get(cluster.id) === signature
  )
    return false;
  let reply: Uint8Array;
  try {
    reply = await body(epoch);
    pushed.set(cluster.id, signature);
  } catch (e) {
    const snap = await readLeaderSnapshot(cluster).catch(() => null);
    const held = snap?.clusters[cluster.id]?.epoch ?? 0;
    if (held <= epoch) throw e;
    await getDb()
      .update(clustersTable)
      .set({ leaderEpoch: held })
      .where(eq(clustersTable.id, cluster.id));
    reply = await body(held);
    pushed.delete(cluster.id);
  }
  if (opts.requireRotations && !keptRotations(reply))
    throw new Error(
      `The cluster leader on ${host.name} is too old to keep a key rotation. Deplo updates it on its own.`,
    );
  // Each heir's leader keeps the roster to take the cluster over from, with Deplo down.
  const epochNow = Math.max(
    (await getClusterById(cluster.id))?.leaderEpoch ?? epoch,
    1,
  );
  for (const heir of heirs)
    await callClusterLeader(
      heir,
      "leader.standby",
      enc({
        cluster: cluster.id,
        epoch: epochNow,
        ...roster,
        self: heir,
        succeed: false,
      }),
    ).catch((e) =>
      console.warn(
        `[cluster-leader] ${cluster.id}: standby on ${heir}: ${e instanceof Error ? e.message : e}`,
      ),
    );
  return true;
}

/**
 * A move inside a cluster goes leader first (ADR-0043): the placement is handed to the leader, and the caller deploys
 * once the leader holds it, so no renewal stops the new copy as placed elsewhere. False when the leader did not say so.
 */
export async function placeAtLeaderFirst(
  cluster: Cluster,
  kind: "app" | "database",
  id: string,
  member: string,
  opts: { within?: number; every?: number } = {},
): Promise<boolean> {
  await recordPlacement({
    clusterId: cluster.id,
    kind,
    workloadId: id,
    members: [member],
    epoch: cluster.leaderEpoch,
  });
  const end = Date.now() + (opts.within ?? 15_000);
  let why = "it did not show the new placement in time";
  try {
    const now = (await getClusterById(cluster.id)) ?? cluster;
    await pushLeaderRoster(now);
    for (;;) {
      const view = (await readLeaderSnapshot(now))?.clusters[cluster.id];
      // A leader that does not serve the cluster renews nobody, so no lease can stop the new copy.
      if (!view) return false;
      const at = view.placement?.find(
        (e) => e.kind === kind && e.id === id && e.replica === 0,
      )?.member;
      if (at === member) return true;
      if (Date.now() >= end) break;
      await new Promise((r) => setTimeout(r, opts.every ?? 500));
    }
  } catch (e) {
    why = messageOf(e);
  }
  console.warn(
    `[cluster-leader] ${cluster.id}: ${kind} ${id} goes to ${member} before its leader holds it: ${why}`,
  );
  return false;
}

/** A leader that keeps rotations says how many it took; an older one only says ok. */
function keptRotations(reply: Uint8Array): boolean {
  try {
    return (
      typeof JSON.parse(new TextDecoder().decode(reply))?.rotations === "number"
    );
  } catch {
    return false;
  }
}

/** Records what the leader said about one member's lease; returns whether it changed. */
export async function setMemberLease(
  clusterId: string,
  serverId: string,
  state: ClusterLeaseState,
): Promise<boolean> {
  declareServerDown(serverId, state !== "ok");
  const rows = await getDb()
    .update(membersTable)
    .set({ leaseState: state, leaseChangedAt: nowIso() })
    .where(
      and(
        eq(membersTable.serverId, serverId),
        eq(membersTable.clusterId, clusterId),
        ne(membersTable.leaseState, state),
        // A fenced server is "not responding" again only to a leader that never heard it: it did not answer since.
        ...(state === "not_responding"
          ? [ne(membersTable.leaseState, "fenced")]
          : []),
      ),
    )
    .returning({ serverId: membersTable.serverId });
  return rows.length > 0;
}
