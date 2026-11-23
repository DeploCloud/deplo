import "server-only";

import { and, eq } from "drizzle-orm";
import {
  leaderHearsEnough,
  leaseSentence,
  standInWhy,
  stoppedSentence,
} from "../../clusters/failover-reach";
import { getDb } from "../../db/client";
import { clusterMembers } from "../../db/schema/control-plane/clusters";
import { servers as serversTable } from "../../db/schema/control-plane/servers";
import { readAgent } from "../../infra/agent-client/connect";
import {
  FAILOVER_MIN_MEMBERS,
  type ClusterLeaseState,
} from "../../types/cluster";
import { placementEntries, readLeaderSnapshot } from "./leader-sync";
import { getClusterById } from "./roster";
import { votingLeaseStates } from "./gone";

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

// Whether the leader that leads now says it leads: then a majority answers it, whatever the stored states say.
export async function leaderSaysItLeads(clusterId: string): Promise<boolean> {
  const cluster = await getClusterById(clusterId);
  if (!cluster) return false;
  const snap = await readLeaderSnapshot(cluster).catch(() => null);
  const v = snap?.clusters?.[clusterId] as { leads?: boolean } | undefined;
  return v?.leads === true;
}

async function answeringNames(clusterId: string): Promise<string[]> {
  const rows = await getDb()
    .select({ name: serversTable.name })
    .from(clusterMembers)
    .innerJoin(serversTable, eq(serversTable.id, clusterMembers.serverId))
    .where(
      and(
        eq(clusterMembers.clusterId, clusterId),
        eq(clusterMembers.leaseState, "ok"),
      ),
    );
  return rows.map((r) => r.name).sort();
}

/** The Activity entry for a member's lease change, read after the change is stored. */
export async function leaseChangeSentence(
  clusterId: string,
  clusterName: string,
  name: string,
  state: ClusterLeaseState,
  serverId?: string,
  standIn = false,
): Promise<string> {
  // A member gone past the grace no longer counts: the last ones keep serving (ADR-0049).
  const leases = await votingLeaseStates(clusterId);
  const answering = leases.filter((s) => s === "ok").length;
  // In a cluster of one nothing could move anyway: the server's own silence is the news.
  const tooFew =
    !standIn &&
    leases.length >= FAILOVER_MIN_MEMBERS &&
    !leaderHearsEnough(answering, leases.length) &&
    !(await leaderSaysItLeads(clusterId));
  const why =
    standIn && state !== "ok"
      ? standInWhy(name, clusterName, await answeringNames(clusterId))
      : undefined;
  if (state !== "fenced" || !serverId)
    return why ? `${why}.` : leaseSentence(name, clusterName, state, tooFew);
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
    why,
  );
}
