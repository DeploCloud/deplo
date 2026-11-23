import "server-only";

import { and, eq, isNotNull } from "drizzle-orm";
import { getDb } from "../../db/client";
import { clusters as clustersTable } from "../../db/schema/control-plane/clusters";
import { servers as serversTable } from "../../db/schema/control-plane/servers";
import {
  callClusterRelay,
  installClusterLeader,
  probeClusterHost,
  removeClusterLeader,
} from "../../infra/agent-client/cluster-host";
import { CLUSTER_HOST_UNSUPPORTED_MESSAGE } from "../../infra/agent-client/errors";
import { nowIso } from "../../ids";
import { requireInstanceAdmin } from "../../membership";
import type { Cluster, ClusterLeaderChoice } from "../../types/cluster";
import { recordActivity } from "../activity";
import { getServerById, listAllServers } from "../servers/roster";
import { dropLeaderBundle, listLeaderBundles } from "./bundle-calls";
import { reconcileClusterBundles } from "./bundles";
import { leaderHost, leaderHostOf } from "./host";
import { tellLeaderReplaced } from "./leader-beat";
import {
  forgetLeaderRoster,
  pushLeaderRoster,
  readLeaderSnapshot,
} from "./leader-sync";
import { pushClusterRoster, relayAddress, syncLeaderRelayRoute } from "./relay";
import {
  clusterMemberServerIds,
  getClusterById,
  requireClusterAdmin,
} from "./roster";
import { clusterHeirs, keepHeirsReady, leadersToMove } from "./succession";
import { recordClusterActivity } from "./cluster-activity";
import type { Server } from "../../types/server";
import { messageOf } from "../../utils";
import { syncClusterNetworkSoon } from "./network";

// Running the leader on another server (spec #176).
// https://deplo.build/docs/operations/clusters/leader#run-the-leader-on-another-server

const NO_HOST =
  "Deplo's own machine is not connected as a server yet, so the leader cannot run on it.";

const warn = (clusterId: string, e: unknown) =>
  console.warn(`[cluster-leader] ${clusterId}: ${messageOf(e)}`);

/**
 * Makes another leader lead the cluster. The stored epoch rises first and the leader is told after, so no two
 * leaders are ever handed the same one. A leader that does not answer leads nothing: this throws and stores nothing.
 */
export async function leadFrom(
  cluster: Cluster,
  to: {
    leaderServerId: string | null;
    leaderTakeoverAt: string | null;
    leaderTeamId?: string;
  },
): Promise<Cluster> {
  const target: Cluster = {
    ...cluster,
    leaderServerId: to.leaderServerId,
    leaderTakeoverAt: to.leaderTakeoverAt,
  };
  const next = await leaderHost(target);
  if (!next) throw new Error(NO_HOST);
  const before = await leaderHost(cluster);
  // Its buffer may hold events of an earlier time it led: the watch starts after them.
  const head = Number((await readLeaderSnapshot(target))?.head) || 0;
  const claimed = await getDb()
    .update(clustersTable)
    .set({
      leaderServerId: to.leaderServerId,
      leaderTakeoverAt: to.leaderTakeoverAt,
      leaderEpoch: Math.max(cluster.leaderEpoch, 1) + 1,
      eventSeq: head,
      ...(to.leaderTeamId ? { leaderTeamId: to.leaderTeamId } : {}),
    })
    .where(
      and(
        eq(clustersTable.id, cluster.id),
        eq(clustersTable.leaderEpoch, cluster.leaderEpoch),
      ),
    )
    .returning({ id: clustersTable.id });
  if (claimed.length === 0)
    throw new Error("The cluster's leader changed meanwhile. Try again.");
  forgetLeaderRoster(cluster.id);
  // The watch's next pass repeats a roster this leader did not take.
  const led = (await getClusterById(cluster.id))!;
  await pushLeaderRoster(led).catch((e) => warn(cluster.id, e));
  // The leader's new server joins the cluster's network, and one it left goes off it.
  if (to.leaderServerId !== cluster.leaderServerId)
    syncClusterNetworkSoon(cluster.id);
  // A takeover is from a leader that does not answer; any other one hears it was replaced and stops at once.
  if (before && before.id !== next.id && !to.leaderTakeoverAt)
    await tellLeaderReplaced(before.id, cluster.id, led.leaderEpoch).catch(
      () => {},
    );
  return led;
}

/** The servers the leader can run on, Deplo's own machine first. Not dialed: the move itself asks the agent. */
export async function listClusterLeaderChoices(
  clusterId: string,
): Promise<ClusterLeaderChoice[]> {
  await requireInstanceAdmin();
  const cluster = await getClusterById(clusterId);
  if (!cluster) throw new Error("Cluster not found");
  const own = await leaderHostOf(null);
  const members = await clusterMemberServerIds(clusterId);
  const servers = (await listAllServers()).filter(
    (s) => !s.importOnly && members.includes(s.id),
  );
  return [
    ...servers.filter((s) => s.id === own?.id),
    ...servers.filter((s) => s.id !== own?.id),
  ].map((s) => ({
    serverId: s.id,
    serverName: s.name,
    onDeploHost: s.id === own?.id,
    current: cluster.leaderServerId === (s.id === own?.id ? null : s.id),
    blocked:
      s.status === "offline"
        ? `${s.name} is offline. Bring it back online first.`
        : "",
    // The other servers meet a leader at its own server's proxy; without one they meet at Deplo's machine.
    note:
      s.id === own?.id || relayAddress(s)
        ? ""
        : `${s.name} has no proxy, so a leader there still needs Deplo's machine up to move anything.`,
  }));
}

const forget = (cluster: string): Uint8Array =>
  new TextEncoder().encode(JSON.stringify({ cluster, parties: [] }));

/** The server a leader left: its relay forgets the cluster, and with no cluster left to lead it is uninstalled. */
export async function retireLeader(
  clusterId: string,
  serverId: string,
): Promise<void> {
  const server = await getServerById(serverId);
  if (!server) return;
  // A member next in line keeps its leader: it may lead the cluster without Deplo.
  const cluster = clusterId ? await getClusterById(clusterId) : null;
  if (cluster && (await clusterHeirs(cluster)).includes(serverId)) return;
  const still = await getDb()
    .select({ id: clustersTable.id })
    .from(clustersTable)
    .where(eq(clustersTable.leaderServerId, serverId))
    .limit(1);
  if (still.length > 0) {
    // It leads other clusters: only this one's bundles and roster go.
    for (const b of await listLeaderBundles(serverId, clusterId))
      await dropLeaderBundle(serverId, { ...b, cluster: clusterId });
    if (relayAddress(server))
      await callClusterRelay(serverId, "relay.roster", forget(clusterId));
    return;
  }
  await removeClusterLeader(serverId);
  await syncLeaderRelayRoute(server, false);
}

const retirePending = (serverId: string, at: string | null) =>
  getDb()
    .update(serversTable)
    .set({ clusterLeaderRetirePendingAt: at })
    .where(eq(serversTable.id, serverId));

/** Retires a leader, or leaves a mark the sweep finishes: a server that does not answer keeps nothing for good. */
export async function retireLeaderOrQueue(
  clusterId: string,
  serverId: string,
): Promise<void> {
  try {
    await retireLeader(clusterId, serverId);
    await retirePending(serverId, null);
  } catch (e) {
    warn(clusterId, e);
    await retirePending(serverId, nowIso());
  }
}

/** The sweep's half: a leader no cluster uses any more is uninstalled once its server answers. */
// ponytail: one that leads another cluster again keeps the lost cluster's sealed bundles; drop them here if it matters.
export async function reconcileRetiredLeaders(): Promise<void> {
  const pending = await getDb()
    .select({ id: serversTable.id })
    .from(serversTable)
    .where(isNotNull(serversTable.clusterLeaderRetirePendingAt));
  for (const { id } of pending) {
    const leads = await getDb()
      .select({ id: clustersTable.id })
      .from(clustersTable)
      .where(eq(clustersTable.leaderServerId, id))
      .limit(1);
    try {
      if (leads.length === 0) await retireLeader("", id);
    } catch {
      continue;
    }
    await retirePending(id, null);
  }
}

/** "Run the leader on another server": the picked server's agent installs it, and it leads from the next epoch. */
export async function moveClusterLeader(
  clusterId: string,
  serverId: string | null,
): Promise<Cluster> {
  const { teamId, user } = await requireClusterAdmin();
  const cluster = await getClusterById(clusterId);
  if (!cluster) throw new Error("Cluster not found");
  const own = await leaderHostOf(null);
  const target = serverId ? await getServerById(serverId) : own;
  if (!target || target.importOnly)
    throw new Error(serverId ? "Server not found" : NO_HOST);
  await leadOn(cluster, target, teamId);
  await recordActivity(
    "server",
    `Moved the leader of cluster ${cluster.name} to ${target.name}`,
    user.name,
    null,
    teamId,
  );
  return (await getClusterById(clusterId))!;
}

/**
 * Deplo's own pass: a cluster whose leader runs outside it, on Deplo's machine or a server that left, gets it on the
 * member that reaches the others directly and has the most room. Never throws.
 */
export async function placeClusterLeaders(): Promise<void> {
  for (const { cluster, to, toName } of await leadersToMove()) {
    try {
      const target = await getServerById(to);
      if (!target) continue;
      await leadOn(cluster, target, undefined);
      await recordClusterActivity(
        cluster.id,
        `The leader of cluster ${cluster.name} now runs on ${toName}, one of its own servers, so the cluster keeps leading itself while Deplo's machine is down`,
      );
    } catch (e) {
      warn(cluster.id, e);
    }
  }
}

/** The minute's pass: leaders move onto their own clusters, and each member next in line runs a leader. Never throws. */
export async function keepLeadersHome(ids: string[]): Promise<void> {
  await placeClusterLeaders();
  for (const id of ids) {
    const cluster = await getClusterById(id);
    if (!cluster || !(await keepHeirsReady(cluster))) continue;
    // A new line: the members take its orders, its leaders hold the bundles, and the leader names it.
    forgetLeaderRoster(id);
    const push = await pushClusterRoster(id).catch((e) => {
      warn(id, e);
      return null;
    });
    for (const f of push?.failed ?? []) warn(id, f.message);
    await reconcileClusterBundles(id).catch((e) => warn(id, e));
  }
}

/** Installs the leader on the target and has it lead from the next epoch; the server it left is retired. */
async function leadOn(
  cluster: Cluster,
  target: Server,
  teamId: string | undefined,
): Promise<void> {
  const clusterId = cluster.id;
  const own = await leaderHostOf(null);
  // Deplo's own machine is stored as null, however it was picked.
  const next = target.id === own?.id ? null : target.id;
  if (next === cluster.leaderServerId) return;

  const probe = await probeClusterHost(target.id);
  if (probe === "offline")
    throw new Error(
      `${target.name} is offline, so the leader cannot run on it.`,
    );
  if (probe === "too_old") throw new Error(CLUSTER_HOST_UNSUPPORTED_MESSAGE);
  // A server that answers on 443 runs a relay too, so its leader reaches the members while Deplo's machine is down.
  const relay = next === null || relayAddress(target) !== null;
  if (next !== null && relay)
    await syncLeaderRelayRoute(target, true).catch((e) => warn(clusterId, e));
  await installClusterLeader(target.id, { relay });
  // The members take the new leader's orders before it gives any: the old one stops the moment it is told.
  if (next !== null)
    await pushClusterRoster(clusterId, undefined, [target.id]).catch((e) =>
      warn(clusterId, e),
    );

  if (next === null && cluster.leaderTakeoverAt)
    // Deplo's own machine already leads in its place: no hands change, so the epoch stays.
    await getDb()
      .update(clustersTable)
      .set({ leaderServerId: null, leaderTakeoverAt: null })
      .where(eq(clustersTable.id, clusterId));
  else
    await leadFrom(cluster, {
      leaderServerId: next,
      leaderTakeoverAt: null,
      ...(teamId ? { leaderTeamId: teamId } : {}),
    });
  const push = await pushClusterRoster(clusterId);
  for (const f of push.failed) warn(clusterId, f.message);
  // A new leader is a new key: what is live is sealed to it and sent, and the key of the server it left is retired.
  await reconcileClusterBundles(clusterId).catch((e) => warn(clusterId, e));
  if (cluster.leaderServerId)
    await retireLeaderOrQueue(clusterId, cluster.leaderServerId);
}
