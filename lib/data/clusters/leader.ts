import "server-only";

import { getCurrentUser } from "../../auth/current-user";
import { isDeploHostServer } from "../../deploy/domains";
import {
  clusterLeaderStatus,
  clusterPin,
  installClusterLeader,
} from "../../infra/agent-client/cluster-host";
import { AgentClusterUnsupportedError } from "../../infra/agent-client/errors";
import { requireActiveTeamId, requireInstanceAdmin } from "../../membership";
import type { Cluster, ClusterLeader } from "../../types/cluster";
import type { Server } from "../../types/server";
import { versionAtLeast } from "../../version";
import { recordActivity } from "../activity";
import { failingClusterUpdate } from "./binary-rollout";
import { leaderHostOf } from "./host";
import { ensureClusterRelay, pushClusterRoster, relayAddress } from "./relay";
import { getClusterById } from "./roster";

const NO_HOST =
  "Deplo's own machine is not connected as a server yet, so there is nowhere to start the leader.";

function down(
  host: Server | null,
  state: ClusterLeader["state"],
  message: string,
): ClusterLeader {
  return {
    serverId: host?.id ?? null,
    serverName: host?.name ?? "Deplo's machine",
    onDeploHost: host ? isDeploHostServer(host) : true,
    state,
    version: "",
    message,
    takenOverAt: null,
    updateMessage: "",
  };
}

async function readLeader(host: Server | null): Promise<ClusterLeader> {
  if (!host) return down(null, "unavailable", NO_HOST);
  try {
    const s = await clusterLeaderStatus(host.id);
    const base = down(host, "running", "");
    if (!s.installed)
      return down(host, "not_installed", "The leader is not installed yet.");
    if (!s.running)
      return {
        ...base,
        state: "stopped",
        version: s.version,
        message: "The leader is installed but not running.",
      };
    if (!versionAtLeast(s.version, clusterPin().min))
      return {
        ...base,
        state: "outdated",
        version: s.version,
        message:
          "This leader is older than this Deplo accepts. Deplo updates it on its own.",
      };
    return { ...base, version: s.version };
  } catch (e) {
    if (e instanceof AgentClusterUnsupportedError)
      return down(host, "unavailable", e.message);
    return down(
      host,
      "unreachable",
      "Deplo could not reach the server the leader runs on.",
    );
  }
}

/** Where the cluster's leader runs and whether it answers, asked live of that server's agent. */
export async function getClusterLeader(
  clusterId: string,
): Promise<ClusterLeader> {
  await requireInstanceAdmin();
  const cluster = await getClusterById(clusterId);
  if (!cluster) throw new Error("Cluster not found");
  // Where it was put, not who stands in for it: the card says both.
  const host = await leaderHostOf(cluster.leaderServerId);
  const leader = await readLeader(host);
  return {
    ...leader,
    takenOverAt: cluster.leaderServerId ? cluster.leaderTakeoverAt : null,
    updateMessage: await updateMessage(host),
  };
}

// Deplo's own machine stands in for a leader elsewhere, so its failing update is this cluster's too.
async function updateMessage(host: Server | null): Promise<string> {
  const own = await leaderHostOf(null);
  for (const server of [host, own]) {
    const row = server && (await failingClusterUpdate(server.id));
    if (row)
      return `Deplo could not update the leader on ${server.name} to v${row.targetVersion}: ${row.lastError} It retries on its own.`;
  }
  return "";
}

/**
 * Starts the leader where it should run unless it already answers, then makes sure the relay on Deplo's machine
 * runs, has its route in the proxy and has the cluster's roster. Says why when the leader cannot start.
 */
export async function ensureClusterLeader(
  clusterId: string,
): Promise<ClusterLeader> {
  await requireInstanceAdmin();
  const teamId = await requireActiveTeamId();
  const user = (await getCurrentUser())!;
  const cluster = await getClusterById(clusterId);
  if (!cluster) throw new Error("Cluster not found");
  const leader = await startLeader(cluster, user.name, teamId);
  await bringUpRelay(cluster, user.name, teamId);
  return leader;
}

async function startLeader(
  cluster: Cluster,
  actor: string,
  teamId: string,
): Promise<ClusterLeader> {
  const host = await leaderHostOf(cluster.leaderServerId);
  const before = await readLeader(host);
  if (!host || before.state === "running" || before.state === "unavailable")
    return before;
  try {
    await installClusterLeader(host.id, {
      relay: isDeploHostServer(host) || relayAddress(host) !== null,
    });
  } catch (e) {
    return down(
      host,
      "unavailable",
      e instanceof Error ? e.message : "Could not start the leader.",
    );
  }
  const after = await readLeader(host);
  if (after.state === "running")
    await recordActivity(
      "server",
      `Started the leader of cluster ${cluster.name} on ${after.serverName}`,
      actor,
      null,
      teamId,
    );
  return after;
}

// The relay's trouble never undoes the cluster either: the sweep tries again, and the card says why.
async function bringUpRelay(
  cluster: Cluster,
  actor: string,
  teamId: string,
): Promise<void> {
  try {
    const relay = await ensureClusterRelay();
    if (relay.started)
      await recordActivity(
        "server",
        `Started the cluster relay on ${relay.serverName}`,
        actor,
        null,
        teamId,
      );
    if (relay.route === "on")
      await recordActivity(
        "server",
        "Added the cluster relay to the panel's address",
        actor,
        null,
        teamId,
      );
    if (relay.routeError)
      console.warn(`[cluster-relay] ${cluster.id}: ${relay.routeError}`);
    const push = await pushClusterRoster(cluster.id);
    for (const f of push.failed)
      console.warn(`[cluster-relay] ${cluster.id}: ${f.message}`);
  } catch (e) {
    console.warn(
      `[cluster-relay] ${cluster.id}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}
