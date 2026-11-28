import "server-only";

import { inArray } from "drizzle-orm";

import { getDb } from "../../db/client";
import { servers as serversTable } from "../../db/schema/control-plane/servers";
import { lastHeardAt, serverAnswers } from "../../infra/agent-link/registry";
import { clusterOfServer } from "./members";
import { clusterMemberServerIds } from "./roster";

// Deplo says what it does not know: while none of a cluster's servers answers it, they decide on their own.
// https://deplo.build/docs/operations/clusters/failover

/** When Deplo last heard a server of the cluster, while none answers it; null while one does, or it cannot tell yet. */
export async function clusterOutOfReach(
  clusterId: string,
): Promise<string | null> {
  const ids = await clusterMemberServerIds(clusterId);
  if (ids.length === 0 || ids.some((id) => serverAnswers(id) !== false))
    return null;
  let last = Math.max(0, ...ids.map((id) => lastHeardAt(id) ?? 0));
  // A Deplo that restarted since knows only when each was last seen online.
  if (!last)
    for (const r of await getDb()
      .select({ at: serversTable.lastSeenAt })
      .from(serversTable)
      .where(inArray(serversTable.id, ids)))
      last = Math.max(last, Date.parse(r.at ?? "") || 0);
  return last ? new Date(last).toISOString() : null;
}

/** "05:32 UTC" today, "2026-11-22 at 05:32 UTC" before. */
export function sinceClock(iso: string, now = Date.now()): string {
  const day = new Date(now).toISOString().slice(0, 10);
  const time = `${iso.slice(11, 16)} UTC`;
  return iso.startsWith(day) ? time : `${iso.slice(0, 10)} at ${time}`;
}

/** The one sentence pages and Activity say while Deplo cannot reach a cluster. */
export const outOfReachSentence = (since: string, name?: string) =>
  `Deplo cannot reach ${name ? `cluster ${name}` : "this cluster"} since ${sinceClock(since)}: its servers decide on their own`;

/** Why a call to a cluster's server got no answer, when the truth is that Deplo reaches none of that cluster. */
export async function outOfReachFailure(
  serverId: string,
  what?: string,
): Promise<string | null> {
  const cluster = serverId ? await clusterOfServer(serverId) : null;
  const since = cluster ? await clusterOutOfReach(cluster.id) : null;
  if (cluster && !since)
    console.warn(
      `[clusters] ${serverId} of ${cluster.name} is offline; answering: ${(await clusterMemberServerIds(cluster.id)).map((id) => `${id}=${serverAnswers(id)}`).join(" ")}`,
    );
  if (!cluster || !since) return null;
  return what
    ? `Deplo cannot reach cluster ${cluster.name} since ${sinceClock(since)}, so it could not ${what}: its servers keep running without Deplo`
    : `Deplo cannot reach cluster ${cluster.name} since ${sinceClock(since)}: its servers keep running without Deplo`;
}
