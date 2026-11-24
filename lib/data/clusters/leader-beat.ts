import "server-only";

import { getDb } from "../../db/client";
import { clusters as clustersTable } from "../../db/schema/control-plane/clusters";
import { callClusterLeader } from "../../infra/agent-client/cluster-host";
import { CLUSTER_BEAT_TIMEOUT_MS } from "../../infra/agent-client/deadlines";
import { lastHeardAt, serverAnswers } from "../../infra/agent-link/registry";
import { LINK_PING_MS } from "../../infra/agent-link/protocol";
import { instanceFrozen } from "../deplo-move/freeze";
import { leaderHost } from "./host";
import { getClusterById } from "./roster";

// Deplo says every few seconds at which epoch each cluster is led. A leader that hears exactly half of its
// servers leads only on that word, so two leaders never hold one half each (docs/agents/cluster-rollout.md §5).

export const BEAT_EVERY_MS = 2_000;

/** How long Deplo asks its word to hold; a leader older than that holds every word 20 s (`DeploFor` in deplo-cluster). */
export const TRUST_MS = 8_000;
const LEGACY_TRUST_MS = 20_000;
// What a beat may take to reach the leader after it left: the wait covers it.
const IN_TRANSIT_MS = 5_000;
const SILENT_AFTER_MS = 2 * LINK_PING_MS - 1_000;

/** How long a leader whose word holds 20 s goes unnamed before another may lead. */
export const TAKEOVER_AFTER_MS = LEGACY_TRUST_MS + IN_TRANSIT_MS;

const enc = (v: unknown): Uint8Array =>
  new TextEncoder().encode(JSON.stringify(v));

// When each cluster's leader may last have heard its epoch from this Deplo: a beat that left, answered or not.
const named = new Map<string, number>();
// How long that leader said its word holds, an earlier and longer one included; unknown is 20 s.
const holds = new Map<string, number>();
// Clusters whose stored leader did not take the last beat: Deplo checks on them at once, not at the next tick.
const missed = new Set<string>();
const inFlight = new Set<string>();
const clock = { now: () => Date.now(), startedAt: Date.now() };
// The member next in line Deplo gives its word to while the stored leader is silent, at the epoch it asks to lead.
const heirs = new Map<string, { serverId: string; epoch: number }>();
// Clusters whose word an heir held and lost: nobody is named until that word is over.
const held = new Set<string>();

/** Test seam: forget every beat. With a clock, Deplo started at its present; without, it has been up forever. */
export function __setLeaderBeatClockForTest(now: (() => number) | null): void {
  named.clear();
  holds.clear();
  missed.clear();
  heirs.clear();
  held.clear();
  clock.now = now ?? (() => Date.now());
  clock.startedAt = now ? now() : Number.NEGATIVE_INFINITY;
}

/** Whether the cluster's leader may still be leading on Deplo's last word. A Deplo that just started assumes so. */
export function leaderNamedRecently(clusterId: string): boolean {
  const at = named.get(clusterId) ?? clock.startedAt;
  const hold = named.has(clusterId)
    ? (holds.get(clusterId) ?? LEGACY_TRUST_MS)
    : LEGACY_TRUST_MS;
  return clock.now() - at < hold + IN_TRANSIT_MS;
}

/** The clusters whose stored leader did not take the last beat. */
export function leadersMissingBeats(): string[] {
  return [...missed];
}

/** Deplo's word goes to this heir, at the epoch it tries, instead of the stored leader (ADR-0043, 23 Nov 2026). */
export function nameHeir(
  clusterId: string,
  serverId: string,
  epoch: number,
): void {
  heirs.set(clusterId, { serverId, epoch });
  held.delete(clusterId);
}

export function namedHeir(
  clusterId: string,
): { serverId: string; epoch: number } | null {
  return heirs.get(clusterId) ?? null;
}

/** Takes the word back from an heir; unless it now leads as the stored leader, nobody is named until it is over. */
export function forgetHeir(clusterId: string, led = false): void {
  if (heirs.delete(clusterId) && !led) held.add(clusterId);
}

async function beat(
  serverId: string,
  epochs: Record<string, number>,
): Promise<void> {
  let left = false;
  try {
    // A server not heard for longer than two of the link's pings is not reached: the beat would only wait out its
    // Hello, while the leader that may replace it waits on this miss.
    const heard = lastHeardAt(serverId);
    if (
      serverAnswers(serverId) === false ||
      (heard !== null && Date.now() - heard > SILENT_AFTER_MS)
    )
      throw new Error("the server does not answer");
    const raw = await callClusterLeader(
      serverId,
      "leader.beat",
      enc({ epochs, trustMs: TRUST_MS }),
      { timeoutMs: CLUSTER_BEAT_TIMEOUT_MS, sent: () => (left = true) },
    );
    const said = holdsOf(raw);
    for (const id of Object.keys(epochs)) {
      holds.set(id, said);
      missed.delete(id);
    }
  } catch (e) {
    for (const id of Object.keys(epochs)) missed.add(id);
    throw e;
  } finally {
    if (left) for (const id of Object.keys(epochs)) named.set(id, clock.now());
  }
}

// How long the leader says Deplo's word holds there: a leader older than that holds every word 20 s.
function holdsOf(raw: Uint8Array): number {
  try {
    const ms = (
      JSON.parse(new TextDecoder().decode(raw)) as { holdsMs?: unknown }
    ).holdsMs;
    return typeof ms === "number" && ms > 0 ? ms : LEGACY_TRUST_MS;
  } catch {
    return LEGACY_TRUST_MS;
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
    const heir = heirs.get(id);
    if (!heir && held.has(id)) {
      if (leaderNamedRecently(id)) continue;
      held.delete(id);
    }
    const cluster = await getClusterById(id);
    const host = heir
      ? { id: heir.serverId }
      : cluster && (await leaderHost(cluster));
    if (!cluster || !host) continue;
    const epochs = byHost.get(host.id) ?? {};
    epochs[id] = heir ? heir.epoch : Math.max(cluster.leaderEpoch, 1);
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
