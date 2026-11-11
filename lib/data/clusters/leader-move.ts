import "server-only";

import { and, eq } from "drizzle-orm";
import { getCurrentUser } from "../../auth/current-user";
import { getDb } from "../../db/client";
import { clusters as clustersTable } from "../../db/schema/control-plane/clusters";
import {
  callClusterRelay,
  installClusterLeader,
  probeClusterHost,
  removeClusterLeader,
} from "../../infra/agent-client/cluster-host";
import { CLUSTER_HOST_UNSUPPORTED_MESSAGE } from "../../infra/agent-client/errors";
import { requireActiveTeamId, requireInstanceAdmin } from "../../membership";
import type { Cluster, ClusterLeaderChoice } from "../../types/cluster";
import { recordActivity } from "../activity";
import { getServerById, listAllServers } from "../servers/roster";
import { dropLeaderBundle, listLeaderBundles } from "./bundle-calls";
import { reconcileClusterBundles } from "./bundles";
import { leaderHost, leaderHostOf } from "./host";
import {
  forgetLeaderRoster,
  pushLeaderRoster,
  readLeaderSnapshot,
} from "./leader-sync";
import { pushClusterRoster, relayAddress, syncLeaderRelayRoute } from "./relay";
import { getClusterById } from "./roster";

// Running the leader on another server (spec #176).
// https://deplo.build/docs/operations/clusters#run-the-leader-on-another-server

const NO_HOST =
  "Deplo's own machine is not connected as a server yet, so the leader cannot run on it.";

const warn = (clusterId: string, e: unknown) =>
  console.warn(
    `[cluster-leader] ${clusterId}: ${e instanceof Error ? e.message : String(e)}`,
  );

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
  if (!(await leaderHost(target))) throw new Error(NO_HOST);
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
  await pushLeaderRoster((await getClusterById(cluster.id))!).catch((e) =>
    warn(cluster.id, e),
  );
  return (await getClusterById(cluster.id))!;
}

/** The servers the leader can run on, Deplo's own machine first. Not dialed: the move itself asks the agent. */
export async function listClusterLeaderChoices(
  clusterId: string,
): Promise<ClusterLeaderChoice[]> {
  await requireInstanceAdmin();
  const cluster = await getClusterById(clusterId);
  if (!cluster) throw new Error("Cluster not found");
  const own = await leaderHostOf(null);
  const servers = (await listAllServers()).filter((s) => !s.importOnly);
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
  }));
}

const forget = (cluster: string): Uint8Array =>
  new TextEncoder().encode(JSON.stringify({ cluster, parties: [] }));

/** The server a leader left: its relay forgets the cluster, and with no cluster left to lead it is uninstalled. */
async function retireLeader(
  clusterId: string,
  serverId: string,
): Promise<void> {
  const server = await getServerById(serverId);
  if (!server) return;
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

/** "Run the leader on another server": the picked server's agent installs it, and it leads from the next epoch. */
export async function moveClusterLeader(
  clusterId: string,
  serverId: string | null,
): Promise<Cluster> {
  await requireInstanceAdmin();
  const teamId = await requireActiveTeamId();
  const user = (await getCurrentUser())!;
  const cluster = await getClusterById(clusterId);
  if (!cluster) throw new Error("Cluster not found");
  const own = await leaderHostOf(null);
  const target = serverId ? await getServerById(serverId) : own;
  if (!target || target.importOnly)
    throw new Error(serverId ? "Server not found" : NO_HOST);
  // Deplo's own machine is stored as null, however it was picked.
  const next = target.id === own?.id ? null : target.id;
  if (next === cluster.leaderServerId) return cluster;

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
      leaderTeamId: teamId,
    });
  const push = await pushClusterRoster(clusterId);
  for (const f of push.failed) warn(clusterId, f.message);
  // A new leader is a new key: what is live is sealed to it and sent, and the key of the server it left is retired.
  await reconcileClusterBundles(clusterId).catch((e) => warn(clusterId, e));
  // ponytail: a server that is offline now keeps its idle leader installed; sweep for those if it ever matters.
  if (cluster.leaderServerId)
    await retireLeader(clusterId, cluster.leaderServerId).catch((e) =>
      warn(clusterId, e),
    );
  await recordActivity(
    "server",
    `Moved the leader of cluster ${cluster.name} to ${target.name}`,
    user.name,
    null,
    teamId,
  );
  return (await getClusterById(clusterId))!;
}
