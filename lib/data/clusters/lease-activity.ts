import "server-only";

import {
  leaderHearsEnough,
  leaseSentence,
} from "../../clusters/failover-reach";
import {
  FAILOVER_MIN_MEMBERS,
  type ClusterLeaseState,
} from "../../types/cluster";
import { clusterLeaseStates } from "./roster";

/** The Activity entry for a member's lease change, read after the change is stored. */
export async function leaseChangeSentence(
  clusterId: string,
  clusterName: string,
  name: string,
  state: ClusterLeaseState,
): Promise<string> {
  const leases = await clusterLeaseStates(clusterId);
  const answering = leases.filter((s) => s === "ok").length;
  // In a cluster of one nothing could move anyway: the server's own silence is the news.
  const tooFew =
    leases.length >= FAILOVER_MIN_MEMBERS &&
    !leaderHearsEnough(answering, leases.length);
  return leaseSentence(name, clusterName, state, tooFew);
}
