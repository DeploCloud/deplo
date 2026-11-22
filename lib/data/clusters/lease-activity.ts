import "server-only";

import {
  leaderHearsEnough,
  leaseSentence,
  stoppedSentence,
} from "../../clusters/failover-reach";
import { readAgent } from "../../infra/agent-client/connect";
import {
  FAILOVER_MIN_MEMBERS,
  type ClusterLeaseState,
} from "../../types/cluster";
import { placementEntries } from "./leader-sync";
import { clusterLeaseStates } from "./roster";

/** Whether the server agent says none of these stacks runs a container; null when it does not answer. */
async function allStopped(
  serverId: string,
  writers: { id: string; slug: string }[],
): Promise<boolean | null> {
  try {
    const conn = await readAgent(serverId);
    try {
      for (const w of writers)
        if ((await conn.listInstances(w.id, w.slug, "")).some((i) => i.running))
          return false;
      return true;
    } finally {
      conn.close();
    }
  } catch {
    return null;
  }
}

/** The Activity entry for a member's lease change, read after the change is stored. */
export async function leaseChangeSentence(
  clusterId: string,
  clusterName: string,
  name: string,
  state: ClusterLeaseState,
  serverId?: string,
): Promise<string> {
  const leases = await clusterLeaseStates(clusterId);
  const answering = leases.filter((s) => s === "ok").length;
  // In a cluster of one nothing could move anyway: the server's own silence is the news.
  const tooFew =
    leases.length >= FAILOVER_MIN_MEMBERS &&
    !leaderHearsEnough(answering, leases.length);
  if (state !== "fenced" || !serverId)
    return leaseSentence(name, clusterName, state, tooFew);
  // Said as it is: what that server had to stop, and whether its agent says it did (decision 7, ADR-0049).
  const writers = (await placementEntries(clusterId)).filter(
    (e) => e.member === serverId && e.singleWriter,
  );
  const stopped =
    writers.length > 0
      ? await allStopped(
          serverId,
          writers.map((w) => ({ id: w.id, slug: w.slug })),
        )
      : true;
  return stoppedSentence(
    name,
    clusterName,
    tooFew,
    writers.map((w) => w.slug),
    stopped,
  );
}
