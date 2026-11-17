import "server-only";

import { appKeepsVolume, type StoredOnDisk } from "../../apps/failover-copy";
import { CLUSTER_SUPERVISE_CAPABILITY } from "../../infra/agent-client/hello-capabilities";
import { serverSupports } from "../../infra/agent-client/preflight";
import type { Database } from "../../types/database";
import { clusterMemberServerIds } from "./roster";

// A cluster's databases and Apps with stored data render restart policy "no" once every member's agent starts them
// itself under their lease: a server back from a power cut then never starts a copy that runs elsewhere (deplo#237).
// One member that cannot say so keeps Docker's own policy for all, since a failover may start the stack on any member.

/** Whether every member of the cluster's agent starts single-writer stacks itself. */
export async function clusterSupervisesWriters(
  clusterId: string,
): Promise<boolean> {
  const ids = await clusterMemberServerIds(clusterId);
  if (ids.length === 0) return false;
  for (const id of ids) {
    if (!(await serverSupports(id, CLUSTER_SUPERVISE_CAPABILITY))) return false;
  }
  return true;
}

/** Whether this App renders restart policy "no": it keeps data on a cluster whose agents start it under its lease. */
export async function appStartsUnderLease(
  app: StoredOnDisk & { clusterId?: string | null },
): Promise<boolean> {
  return Boolean(
    app.clusterId &&
    appKeepsVolume(app) &&
    (await clusterSupervisesWriters(app.clusterId)),
  );
}

/** Whether this database renders restart policy "no": it runs on a cluster whose agents start it under its lease. */
export async function databaseStartsUnderLease(
  db: Pick<Database, "clusterId">,
): Promise<boolean> {
  return Boolean(
    db.clusterId && (await clusterSupervisesWriters(db.clusterId)),
  );
}
