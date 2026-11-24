import "server-only";

import { and, eq } from "drizzle-orm";
import { getDb } from "../../db/client";
import { clusterMembers } from "../../db/schema/control-plane/clusters";
import { servers as serversTable } from "../../db/schema/control-plane/servers";

/** A server agent's certificate, as a member knows another by it; null before it enrolled. */
async function fingerprintOf(serverId: string): Promise<string | null> {
  const [row] = await getDb()
    .select({ fp: serversTable.agentCertFingerprint })
    .from(serversTable)
    .where(eq(serversTable.id, serverId))
    .limit(1);
  const fp = row?.fp?.toLowerCase() ?? "";
  return /^[0-9a-f]{64}$/.test(fp) ? fp : null;
}

/** Whether two servers are members of one cluster, so they share its private network. */
async function sameCluster(a: string, b: string): Promise<boolean> {
  const rows = await getDb()
    .select({ clusterId: clusterMembers.clusterId })
    .from(clusterMembers)
    .where(eq(clusterMembers.serverId, a));
  for (const r of rows) {
    const [hit] = await getDb()
      .select({ serverId: clusterMembers.serverId })
      .from(clusterMembers)
      .where(
        and(
          eq(clusterMembers.clusterId, r.clusterId),
          eq(clusterMembers.serverId, b),
        ),
      )
      .limit(1);
    if (hit) return true;
  }
  return false;
}

/**
 * Two members a copy can go between over their cluster's private network (ADR-0047), by their certificates;
 * null when they share none, and Deplo carries the copy itself.
 */
export async function memberPair(
  from: string,
  to: string,
): Promise<{ from: string; to: string } | null> {
  if (from === to || !(await sameCluster(from, to))) return null;
  const [a, b] = await Promise.all([fingerprintOf(from), fingerprintOf(to)]);
  return a && b ? { from: a, to: b } : null;
}
