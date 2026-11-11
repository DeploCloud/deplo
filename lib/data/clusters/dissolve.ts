import "server-only";

import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { getCurrentUser } from "../../auth/current-user";
import { getDb } from "../../db/client";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import {
  clusterImageCopies,
  clusterMembers as membersTable,
  clusters as clustersTable,
  failoverBundlePushes as pushes,
  workloadPlacements,
} from "../../db/schema/control-plane/clusters";
import { databases as databasesTable } from "../../db/schema/control-plane/databases";
import { teams as teamsTable } from "../../db/schema/control-plane/identity";
import { servers as serversTable } from "../../db/schema/control-plane/servers";
import {
  callClusterLeader,
  clusterLeaderStatus,
  probeClusterMember,
  removeClusterLeader,
} from "../../infra/agent-client/cluster-host";
import { nowIso } from "../../ids";
import { requireActiveTeamId, requireInstanceAdmin } from "../../membership";
import {
  failoverOn,
  type Cluster,
  type ClusterDeletion,
} from "../../types/cluster";
import { recordActivity } from "../activity";
import { endStandby, syncClusterStandbys } from "../databases/standby";
import { instanceFrozen } from "../deplo-move/freeze";
import { getServerById, listAllServers } from "../servers/roster";
import { teardownOrQueue } from "../teardown-queue";
import { leaveAppTunnel } from "./app-tunnel";
import { dropLeaderBundle, forgetLeaderCluster } from "./bundle-calls";
import { hostFor, keyRows } from "./bundles";
import { leaderHostOf } from "./host";
import { retireLeader } from "./leader-move";
import { forgetLeaderRoster, type LeaderSnapshot } from "./leader-sync";
import { clusterOfServer } from "./members";
import { listMemberWorkloads } from "./member-workloads";
import type { WorkloadKind } from "./placement";
import {
  pushClusterRosters,
  pushMembership,
  releaseClusterMember,
  syncClusterRelayRoute,
} from "./relay";
import { clusterMemberServerIds, getClusterById } from "./roster";
import { stopClusterWatch } from "./watch-scheduler";

// Taking a cluster apart: removing a member and deleting the cluster (spec #176).
// https://deplo.build/docs/operations/clusters#remove-a-server

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const warn = (clusterId: string, e: unknown) =>
  console.warn(`[cluster-dissolve] ${clusterId}: ${message(e)}`);

type DbTx = Parameters<
  Parameters<ReturnType<typeof getDb>["transaction"]>[0]
>[0];

interface Held {
  kind: WorkloadKind;
  id: string;
  name: string;
  /** The stack's name on its server. */
  slug: string;
  teamId: string;
  serverId: string;
}

/** Every App and database placed on the cluster, with the server each one runs on now. */
async function clusterWorkloads(clusterId: string): Promise<Held[]> {
  const db = getDb();
  const [apps, dbs] = await Promise.all([
    db
      .select({
        id: appsTable.id,
        name: appsTable.name,
        slug: appsTable.slug,
        teamId: appsTable.teamId,
        serverId: appsTable.serverId,
      })
      .from(appsTable)
      .where(eq(appsTable.clusterId, clusterId))
      .orderBy(appsTable.name),
    db
      .select({
        id: databasesTable.id,
        name: databasesTable.name,
        slug: databasesTable.host,
        teamId: databasesTable.teamId,
        serverId: databasesTable.serverId,
      })
      .from(databasesTable)
      .where(eq(databasesTable.clusterId, clusterId))
      .orderBy(databasesTable.name),
  ]);
  return [
    ...apps.map((a) => ({ kind: "app" as const, ...a })),
    ...dbs.map((d) => ({ kind: "database" as const, ...d })),
  ];
}

interface Placed {
  /** The other members a spread App also runs on, in placement order. */
  alsoOn: string[];
  /** A replica has no member: it found no room. */
  waiting: boolean;
}

/** Where the leader put each workload besides the server its row names. */
async function placedElsewhere(held: Held[]): Promise<Map<string, Placed>> {
  const out = new Map<string, Placed>();
  if (held.length === 0) return out;
  const rows = await getDb()
    .select()
    .from(workloadPlacements)
    .where(
      inArray(
        workloadPlacements.workloadId,
        held.map((w) => w.id),
      ),
    )
    .orderBy(workloadPlacements.replica);
  for (const w of held) {
    const mine = rows.filter((r) => r.kind === w.kind && r.workloadId === w.id);
    out.set(w.id, {
      alsoOn: [
        ...new Set(
          mine
            .map((r) => r.memberServerId)
            .filter((m): m is string => Boolean(m) && m !== w.serverId),
        ),
      ],
      waiting: mine.some((r) => r.memberServerId === null),
    });
  }
  return out;
}

/**
 * The Delete confirmation: what stops failing over. The asking team reads its own Apps and databases by name;
 * another team's are a count under that team's name, never their names.
 */
export async function getClusterDeletion(
  clusterId: string,
): Promise<ClusterDeletion> {
  await requireInstanceAdmin();
  const teamId = await requireActiveTeamId();
  const cluster = await getClusterById(clusterId);
  if (!cluster) throw new Error("Cluster not found");
  const held = await clusterWorkloads(clusterId);
  const placed = await placedElsewhere(held);
  const serverName = new Map(
    (await listAllServers()).map((s) => [s.id, s.name] as const),
  );
  const others = [
    ...new Set(held.map((w) => w.teamId).filter((t) => t !== teamId)),
  ];
  const teams = others.length
    ? await getDb()
        .select({ id: teamsTable.id, name: teamsTable.name })
        .from(teamsTable)
        .where(inArray(teamsTable.id, others))
        .orderBy(teamsTable.name)
    : [];
  return {
    failoverOn: failoverOn((await clusterMemberServerIds(clusterId)).length),
    workloads: held
      .filter((w) => w.teamId === teamId)
      .map((w) => ({
        kind: w.kind,
        name: w.name,
        serverName: serverName.get(w.serverId) ?? "its server",
        stopsOn: (placed.get(w.id)?.alsoOn ?? []).map(
          (id) => serverName.get(id) ?? "another server",
        ),
        waiting: placed.get(w.id)?.waiting ?? false,
      })),
    otherTeams: teams.map((t) => {
      const theirs = held.filter((w) => w.teamId === t.id);
      const apps = theirs.filter((w) => w.kind === "app").length;
      return { teamName: t.name, apps, databases: theirs.length - apps };
    }),
  };
}

// An App spread over several members stays on the first in placement order, which its row already names: one
// server is what an ordinary App runs on. Refusing instead would make an admin wait on another team's setting.
// ponytail: assumes a member's copy is a stack named by the App's slug; #208 owns how a spread App is rendered.
async function stopOtherReplicas(
  held: Held[],
  placed: Map<string, Placed>,
): Promise<void> {
  for (const w of held)
    for (const serverId of placed.get(w.id)?.alsoOn ?? [])
      await teardownOrQueue({
        serverId,
        deployKey: w.slug,
        projectLabel: w.id,
        label: w.name,
        teamId: w.teamId,
      }).catch((e) => warn(w.id, e));
}

/** "2 Apps and 1 database": counts only, so no team reads another team's names. */
export function workloadCount(held: { kind: WorkloadKind }[]): string {
  const apps = held.filter((w) => w.kind === "app").length;
  const dbs = held.length - apps;
  return [
    apps > 0 ? `${apps} App${apps === 1 ? "" : "s"}` : "",
    dbs > 0 ? `${dbs} database${dbs === 1 ? "" : "s"}` : "",
  ]
    .filter(Boolean)
    .join(" and ");
}

const ofKind = (held: Held[], kind: WorkloadKind) =>
  held.filter((w) => w.kind === kind).map((w) => w.id);

/** The cluster lets go of its workloads: each stays on the server it runs on, as an ordinary App or database. */
async function detach(tx: DbTx, clusterId: string): Promise<void> {
  const apps = await tx
    .update(appsTable)
    .set({ clusterId: null })
    .where(eq(appsTable.clusterId, clusterId))
    .returning({ id: appsTable.id });
  const dbs = await tx
    .update(databasesTable)
    .set({ clusterId: null })
    .where(eq(databasesTable.clusterId, clusterId))
    .returning({ id: databasesTable.id });
  for (const [kind, rows] of [
    ["app", apps],
    ["database", dbs],
  ] as const) {
    const ids = rows.map((r) => r.id);
    if (ids.length === 0) continue;
    await tx
      .delete(workloadPlacements)
      .where(
        and(
          eq(workloadPlacements.kind, kind),
          inArray(workloadPlacements.workloadId, ids),
        ),
      );
    await tx
      .delete(pushes)
      .where(
        and(eq(pushes.workloadKind, kind), inArray(pushes.workloadId, ids)),
      );
    if (kind === "app")
      await tx
        .delete(clusterImageCopies)
        .where(inArray(clusterImageCopies.appId, ids));
  }
}

// A database that left its cluster keeps no standby copy: the switch goes off with it (#218).
async function endStandbys(held: Held[]): Promise<void> {
  for (const id of ofKind(held, "database"))
    await endStandby(id).catch((e) => warn(id, e));
}

/** Refuses when a server that still runs work does not answer: cut off unheard, it would stop that work itself a minute later. */
async function assertHoldersAnswer(
  cluster: Cluster,
  held: Held[],
  doing: string,
): Promise<void> {
  for (const serverId of new Set(held.map((w) => w.serverId))) {
    if ((await probeClusterMember(serverId)) !== "offline") continue;
    const name = (await getServerById(serverId))?.name ?? "A server";
    const on = held.filter((w) => w.serverId === serverId);
    throw new Error(
      `${name} does not answer, and ${workloadCount(on)} still run${on.length === 1 ? "s" : ""} on it. Bring it back online, or empty it, before ${doing} ${cluster.name}.`,
    );
  }
}

/** Tells each server's agent it left; one that does not answer is told by the sweep once it does. */
async function leave(clusterId: string, serverIds: string[]): Promise<void> {
  for (const id of serverIds) {
    try {
      await releaseClusterMember(id);
      await getDb()
        .update(serversTable)
        .set({ clusterLeavePendingAt: null })
        .where(eq(serversTable.id, id));
    } catch (e) {
      warn(clusterId, `${id} was not told it left: ${message(e)}`);
    }
  }
}

// A domain that used the App's own tunnel points back at its server, and the connector leaves the stack.
async function leaveTunnels(
  held: Held[],
  actor: { id: string; name: string },
): Promise<void> {
  const { rerouteApp } = await import("../../deploy/build/reroute");
  const { appTunnels } =
    await import("../../db/schema/control-plane/dns-providers");
  const apps = ofKind(held, "app");
  if (apps.length === 0) return;
  const tunnelled = await getDb()
    .select({ appId: appTunnels.appId })
    .from(appTunnels)
    .where(inArray(appTunnels.appId, apps));
  for (const { appId } of tunnelled) {
    try {
      await leaveAppTunnel(appId, actor);
      await rerouteApp(appId);
    } catch (e) {
      warn(appId, e);
    }
  }
}

async function dropBundlesAtLeaders(
  cluster: Cluster,
  held: Held[],
): Promise<void> {
  for (const k of await keyRows(cluster.id)) {
    const hostId = await hostFor(k.serverId).catch(() => null);
    if (!hostId) continue;
    // What is missed here goes with the sweep: a leader drops a bundle no workload of the cluster owns.
    for (const w of held)
      await dropLeaderBundle(hostId, {
        cluster: cluster.id,
        kind: w.kind,
        id: w.id,
      }).catch(() => {});
  }
}

/**
 * "Remove": the server leaves the cluster at once. It must hold nothing, except the last one, which may keep
 * its Apps and databases: they stay where they run, as ordinary ones that no cluster moves.
 */
export async function removeClusterMember(
  clusterId: string,
  serverId: string,
  opts: { keepWorkloads?: boolean } = {},
): Promise<Cluster> {
  await requireInstanceAdmin();
  const teamId = await requireActiveTeamId();
  const user = (await getCurrentUser())!;
  const cluster = await getClusterById(clusterId);
  if (!cluster) throw new Error("Cluster not found");
  const server = await getServerById(serverId);
  const members = await clusterMemberServerIds(clusterId);
  if (!server || !members.includes(serverId))
    throw new Error(
      `${server?.name ?? "That server"} is not in cluster ${cluster.name}.`,
    );
  const last = members.length === 1;
  const held = await listMemberWorkloads(serverId);
  const keep = last && opts.keepWorkloads === true;
  if (held.length > 0 && !keep)
    throw new Error(
      last
        ? `${server.name} is the last server of ${cluster.name} and still runs ${workloadCount(held)}. Choose "Keep its Apps on this server" to remove it.`
        : `${server.name} still runs ${workloadCount(held)}. Empty it first.`,
    );
  // With no member left, the cluster holds nothing: whatever it still names is released with the last one.
  const released = keep ? await clusterWorkloads(clusterId) : [];
  if (keep) await assertHoldersAnswer(cluster, released, "removing it from");

  await getDb().transaction(async (tx) => {
    const locked = await tx
      .select({ id: clustersTable.id })
      .from(clustersTable)
      .where(eq(clustersTable.id, clusterId))
      .for("update");
    if (!locked[0]) throw new Error("Cluster not found");
    const gone = await tx
      .delete(membersTable)
      .where(
        and(
          eq(membersTable.serverId, serverId),
          eq(membersTable.clusterId, clusterId),
        ),
      )
      .returning({ id: membersTable.serverId });
    if (gone.length === 0)
      throw new Error(`${server.name} is not in cluster ${cluster.name}.`);
    if (keep) await detach(tx, clusterId);
    await tx
      .update(serversTable)
      .set({ clusterLeavePendingAt: nowIso() })
      .where(eq(serversTable.id, serverId));
  });

  // Its agent forgets the cluster before the cluster forgets it, so nothing it runs is stopped on the way out.
  await leave(clusterId, [serverId]);
  await pushMembership([clusterId]);
  if (keep) {
    await dropBundlesAtLeaders(cluster, released);
    await endStandbys(released);
    await leaveTunnels(released, user);
  }
  // A copy on the server that left, or of an engine the cluster is now too small for, is seen to at once.
  await syncClusterStandbys(clusterId).catch((e) => warn(clusterId, e));
  await recordActivity(
    "server",
    `Removed server ${server.name} from cluster ${cluster.name}` +
      (released.length > 0 ? `, keeping ${workloadCount(released)} on it` : ""),
    user.name,
    null,
    teamId,
  );
  return (await getClusterById(clusterId))!;
}

/** "stay where they run and no longer fail over", agreeing with how many there are. */
function staysSentence(held: Held[], failover: boolean): string {
  const one = held.length === 1;
  return (
    `${workloadCount(held)} ${one ? "stays where it runs" : "stay where they run"}` +
    (failover ? ` and no longer ${one ? "fails" : "fail"} over` : "")
  );
}

/** The leaders and the relays stop serving a cluster that is gone; with none left, Deplo's machine runs neither. */
async function retireCluster(cluster: Cluster): Promise<void> {
  const own = await leaderHostOf(null);
  // Both may have led it: the one it was moved to, and Deplo's own machine standing in.
  for (const id of new Set([cluster.leaderServerId, own?.id ?? null])) {
    if (id)
      await forgetLeaderCluster(id, cluster.id).catch((e) =>
        warn(cluster.id, e),
      );
  }
  if (cluster.leaderServerId)
    await retireLeader(cluster.id, cluster.leaderServerId).catch((e) =>
      warn(cluster.id, e),
    );
  const left = await getDb()
    .select({ id: clustersTable.id })
    .from(clustersTable)
    .limit(1);
  if (left.length > 0) {
    // An empty roster: the relay forgets the cluster and cuts off whoever it still let through.
    await pushClusterRosters([cluster.id]);
    return;
  }
  // The sweep finishes either one that fails here.
  if (own) await removeClusterLeader(own.id).catch((e) => warn(cluster.id, e));
  await syncClusterRelayRoute().catch((e) => warn(cluster.id, e));
}

/**
 * "Delete": the cluster goes and every App and database stays on the server it runs on, as an ordinary one.
 * Their failover backups stay as ordinary schedules; nothing is stopped, redeployed or deleted.
 */
export async function deleteCluster(clusterId: string): Promise<void> {
  await requireInstanceAdmin();
  const teamId = await requireActiveTeamId();
  const user = (await getCurrentUser())!;
  const cluster = await getClusterById(clusterId);
  if (!cluster) throw new Error("Cluster not found");
  const members = await clusterMemberServerIds(clusterId);
  const held = await clusterWorkloads(clusterId);
  await assertHoldersAnswer(cluster, held, "deleting");
  const placed = await placedElsewhere(held);

  await getDb().transaction(async (tx) => {
    const locked = await tx
      .select({ id: clustersTable.id })
      .from(clustersTable)
      .where(eq(clustersTable.id, clusterId))
      .for("update");
    if (!locked[0]) throw new Error("Cluster not found");
    await detach(tx, clusterId);
    if (members.length > 0)
      await tx
        .update(serversTable)
        .set({ clusterLeavePendingAt: nowIso() })
        .where(inArray(serversTable.id, members));
    // Its members, its teams and its leader keys go with the row.
    await tx.delete(clustersTable).where(eq(clustersTable.id, clusterId));
  });
  stopClusterWatch(clusterId);
  forgetLeaderRoster(clusterId);

  // Each agent forgets the cluster before the cluster forgets it, so nothing it runs is stopped on the way out.
  await leave(clusterId, members);
  await retireCluster(cluster);
  await stopOtherReplicas(held, placed);
  await endStandbys(held);
  await leaveTunnels(held, user);

  const failover = failoverOn(members.length);
  const mine = held.filter((w) => w.teamId === teamId);
  await recordActivity(
    "server",
    `Deleted cluster ${cluster.name}` +
      (mine.length > 0 ? `: this team's ${staysSentence(mine, failover)}` : ""),
    user.name,
    null,
    teamId,
  );
  // Every other team with work on it reads what happened to its own.
  for (const other of new Set(held.map((w) => w.teamId))) {
    if (other === teamId) continue;
    const theirs = held.filter((w) => w.teamId === other);
    await recordActivity(
      "server",
      `Deleted cluster ${cluster.name}: this team's ${staysSentence(theirs, failover)}`,
      user.name,
      null,
      other,
    );
  }
}

// A leader that missed the delete still serves the cluster, bundles included: it forgets what Deplo no longer has.
async function forgetOrphans(hostId: string): Promise<void> {
  const raw = await callClusterLeader(hostId, "leader.snapshot");
  const serving = Object.keys(
    (JSON.parse(new TextDecoder().decode(raw)) as LeaderSnapshot).clusters ??
      {},
  );
  // Read after the snapshot: a cluster's row exists before its leader hears of it.
  const known = new Set(
    (await getDb().select({ id: clustersTable.id }).from(clustersTable)).map(
      (c) => c.id,
    ),
  );
  for (const id of serving)
    if (!known.has(id)) await forgetLeaderCluster(hostId, id);
}

/** The sweep's job: whatever a removal or a delete could not finish at the time is finished now. */
export async function reconcileDissolvedClusters(): Promise<void> {
  if (await instanceFrozen()) return;
  await reconcileLeftMembers();
  const own = await leaderHostOf(null);
  const clusters = await getDb()
    .select({ leader: clustersTable.leaderServerId })
    .from(clustersTable);
  if (clusters.length === 0) {
    // No cluster is left, so Deplo's machine runs no leader and no relay; the relay sweep takes the route out.
    if (own && (await clusterLeaderStatus(own.id)).installed)
      await removeClusterLeader(own.id);
    return;
  }
  for (const id of new Set([own?.id, ...clusters.map((c) => c.leader)]))
    if (id) await forgetOrphans(id).catch((e) => warn(id, e));
}

/** A server that left its cluster while it did not answer is told, once it answers. */
// ponytail: what its dead lease stopped meanwhile stays stopped; starting it again is the returning-member work of #205.
export async function reconcileLeftMembers(): Promise<void> {
  const pending = await getDb()
    .select({ id: serversTable.id })
    .from(serversTable)
    .where(isNotNull(serversTable.clusterLeavePendingAt));
  for (const { id } of pending) {
    try {
      await releaseClusterMember(id);
    } catch {
      continue;
    }
    await getDb()
      .update(serversTable)
      .set({ clusterLeavePendingAt: null })
      .where(eq(serversTable.id, id));
    // It joined a cluster again meanwhile: it forgot the old one just now, so it is told to dial for the new one.
    const now = await clusterOfServer(id);
    if (now) await pushClusterRosters([now.id]);
  }
}
