import "server-only";

import { getCurrentUser } from "../../auth/current-user";
import { isDeploHostServer } from "../../deploy/domains";
import {
  clusterLeaderStatus,
  installClusterLeader,
} from "../../infra/agent-client/cluster-host";
import { AgentClusterUnsupportedError } from "../../infra/agent-client/errors";
import { requireActiveTeamId, requireInstanceAdmin } from "../../membership";
import type { Cluster, ClusterLeader } from "../../types/cluster";
import type { Server } from "../../types/server";
import { recordActivity } from "../activity";
import { getServerById, listAllServers } from "../servers/roster";
import { getClusterById } from "./roster";

const NO_HOST =
  "Deplo's own machine is not connected as a server yet, so there is nowhere to start the leader.";

// The machine the leader runs on: the server it was moved to, else Deplo's own.
async function leaderHost(cluster: Cluster): Promise<Server | null> {
  if (cluster.leaderServerId) return getServerById(cluster.leaderServerId);
  return (
    (await listAllServers()).find(
      (s) => !s.importOnly && isDeploHostServer(s),
    ) ?? null
  );
}

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
  return readLeader(await leaderHost(cluster));
}

/** Starts the leader where it should run unless it already answers; says why when it cannot. */
export async function ensureClusterLeader(
  clusterId: string,
): Promise<ClusterLeader> {
  await requireInstanceAdmin();
  const teamId = await requireActiveTeamId();
  const user = (await getCurrentUser())!;
  const cluster = await getClusterById(clusterId);
  if (!cluster) throw new Error("Cluster not found");
  const host = await leaderHost(cluster);
  const before = await readLeader(host);
  if (!host || before.state === "running" || before.state === "unavailable")
    return before;
  try {
    await installClusterLeader(host.id);
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
      user.name,
      null,
      teamId,
    );
  return after;
}
