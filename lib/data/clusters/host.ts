import "server-only";

import { isDeploHostServer } from "../../deploy/domains";
import type { Cluster } from "../../types/cluster";
import type { Server } from "../../types/server";
import { getServerById, listAllServers } from "../servers/roster";

/** The machine a cluster's leader runs on: the server it was moved to, else Deplo's own. */
export async function leaderHost(cluster: Cluster): Promise<Server | null> {
  if (cluster.leaderServerId) return getServerById(cluster.leaderServerId);
  return (
    (await listAllServers()).find(
      (s) => !s.importOnly && isDeploHostServer(s),
    ) ?? null
  );
}
