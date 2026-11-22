import "server-only";

import { eq } from "drizzle-orm";

import { getDb } from "../../db/client";
import { clusterMembers } from "../../db/schema/control-plane/clusters";

// The members the leader no longer counts for a majority, as its member_gone and member_rejoined events say (ADR-0049).
const KEY = Symbol.for("deplo.cluster.gone");
const g = globalThis as unknown as { [KEY]?: Map<string, Set<string>> };
// ponytail: in memory, so a Deplo restarted meanwhile counts them again until the leader's next word.
const gone = () => (g[KEY] ??= new Map());

export function memberGone(
  clusterId: string,
  serverId: string,
  out: boolean,
): void {
  const set = gone().get(clusterId) ?? new Set<string>();
  if (out) set.add(serverId);
  else set.delete(serverId);
  gone().set(clusterId, set);
}

/** Test seam: forget every member taken out. */
export function __forgetGone(): void {
  gone().clear();
}

/** The lease state of each member that counts for a majority. */
export async function votingLeaseStates(clusterId: string): Promise<string[]> {
  const out = gone().get(clusterId) ?? new Set<string>();
  const rows = await getDb()
    .select({ id: clusterMembers.serverId, state: clusterMembers.leaseState })
    .from(clusterMembers)
    .where(eq(clusterMembers.clusterId, clusterId));
  return rows.filter((r) => !out.has(r.id)).map((r) => r.state);
}
