import "server-only";

import { getDb } from "../../db/client";
import { clusters as clustersTable } from "../../db/schema/control-plane/clusters";
import { callClusterLeader } from "../../infra/agent-client/cluster-host";
import { CLUSTER_BEAT_TIMEOUT_MS } from "../../infra/agent-client/deadlines";
import { instanceFrozen } from "../deplo-move/freeze";
import { leaderHost } from "./host";
import { getClusterById } from "./roster";

// Deplo says every few seconds at which epoch each cluster is led. A leader that hears exactly half of its
// servers leads only on that word, so two leaders never hold one half each (docs/agents/cluster-rollout.md §5).

export const BEAT_EVERY_MS = 5_000;

/** How long a leader goes unnamed before another may lead: longer than the 20 s it trusts a beat (`DeploFor` in deplo-cluster). */
export const TAKEOVER_AFTER_MS = 25_000;

const enc = (v: unknown): Uint8Array =>
  new TextEncoder().encode(JSON.stringify(v));

// When each cluster's leader may last have heard its epoch from this Deplo: a beat that left, answered or not.
const named = new Map<string, number>();
const inFlight = new Set<string>();
const clock = { now: () => Date.now(), startedAt: Date.now() };

/** Test seam: forget every beat. With a clock, Deplo started at its present; without, it has been up forever. */
export function __setLeaderBeatClockForTest(now: (() => number) | null): void {
  named.clear();
  clock.now = now ?? (() => Date.now());
  clock.startedAt = now ? now() : Number.NEGATIVE_INFINITY;
}

/** Whether the cluster's leader may still be leading on Deplo's last word. A Deplo that just started assumes so. */
export function leaderNamedRecently(clusterId: string): boolean {
  const at = named.get(clusterId) ?? clock.startedAt;
  return clock.now() - at < TAKEOVER_AFTER_MS;
}

async function beat(
  serverId: string,
  epochs: Record<string, number>,
): Promise<void> {
  let left = false;
  try {
    await callClusterLeader(serverId, "leader.beat", enc({ epochs }), {
      timeoutMs: CLUSTER_BEAT_TIMEOUT_MS,
      sent: () => (left = true),
    });
  } finally {
    if (left) for (const id of Object.keys(epochs)) named.set(id, clock.now());
  }
}

/**
 * One beat to every leader, through the agent that supervises it: one call per server, naming every cluster it
 * leads. A server whose last beat is still on its way is skipped, so a slow one never holds up the others.
 */
export async function beatClusterLeaders(): Promise<void> {
  if (await instanceFrozen()) return;
  const rows = await getDb()
    .select({ id: clustersTable.id })
    .from(clustersTable);
  const byHost = new Map<string, Record<string, number>>();
  for (const { id } of rows) {
    const cluster = await getClusterById(id);
    const host = cluster && (await leaderHost(cluster));
    if (!host) continue;
    const epochs = byHost.get(host.id) ?? {};
    epochs[id] = Math.max(cluster.leaderEpoch, 1);
    byHost.set(host.id, epochs);
  }
  await Promise.all(
    [...byHost].map(async ([serverId, epochs]) => {
      if (inFlight.has(serverId)) return;
      inFlight.add(serverId);
      // A leader that does not answer loses the tie on its own; the watch tick decides who leads instead.
      await beat(serverId, epochs)
        .catch(() => {})
        .finally(() => inFlight.delete(serverId));
    }),
  );
}

/** Tells the leader a cluster was taken from the epoch another one leads it at, so it stops without waiting to find out. */
export async function tellLeaderReplaced(
  serverId: string,
  clusterId: string,
  epoch: number,
): Promise<void> {
  await callClusterLeader(
    serverId,
    "leader.beat",
    enc({ epochs: { [clusterId]: epoch } }),
    { timeoutMs: CLUSTER_BEAT_TIMEOUT_MS },
  );
}
