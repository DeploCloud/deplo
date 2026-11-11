import "server-only";

import { isDeploHostServer } from "../../deploy/domains";
import type { Cluster } from "../../types/cluster";
import type { Server } from "../../types/server";
import { getServerById, listAllServers } from "../servers/roster";

/** The machine a leader runs on: the server it was moved to, or Deplo's own for null. */
export async function leaderHostOf(
  serverId: string | null,
): Promise<Server | null> {
  if (serverId) return getServerById(serverId);
  return (
    (await listAllServers()).find(
      (s) => !s.importOnly && isDeploHostServer(s),
    ) ?? null
  );
}

/** The machine whose leader leads the cluster now: Deplo's own while it stands in for a leader that does not answer. */
export async function leaderHost(cluster: Cluster): Promise<Server | null> {
  return leaderHostOf(cluster.leaderTakeoverAt ? null : cluster.leaderServerId);
}
