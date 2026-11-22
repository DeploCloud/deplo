import "server-only";

import { and, eq, lt } from "drizzle-orm";
import { getDb } from "../../db/client";
import { clusters as clustersTable } from "../../db/schema/control-plane/clusters";
import { watchClusterLeader } from "../../infra/agent-client/cluster-host";
import type { ClusterLeaseState } from "../../types/cluster";
import { instanceFrozen } from "../deplo-move/freeze";
import {
  adoptLeaderMoves,
  applyFailedOver,
  applyFailoverSummary,
  applyMoveFailed,
} from "./failover";
import { syncClusterAnswerDnsSoon } from "./answer-dns";
import { leaderHost } from "./host";
import {
  forgetLeaderRoster,
  pushLeaderRoster,
  readLeaderSnapshot,
  setMemberLease,
} from "./leader-sync";
import { recordPlacement } from "./placement";
import { applyLeftSaved, applyMemberReturned } from "./returned";
import { reconcileClusterBundles } from "./bundles";
import { recordClusterActivity } from "./cluster-activity";
import { reconcileClusterDatabaseBundles } from "./database-bundles";
import { getClusterById } from "./roster";
import { markPreviewsOffline } from "../../deploy/preview-lifecycle/cluster-member";
import { getServerById } from "../servers/roster";
import { messageOf } from "../../utils";
import { leaseChangeSentence } from "./lease-activity";
import { moveStarted } from "./moves";

// The control plane's long-lived watch on a cluster's leader, through the agent that supervises it (spec #176).
// Events carry a sequence; the last one applied is stored, so a restart or a reconnect replays only what is new.

export interface LeaderEvent {
  seq: number;
  type: string;
  cluster: string;
  data: Record<string, unknown>;
}

export type WatchLine =
  | { kind: "hello"; head: number; gap: boolean }
  | { kind: "event"; event: LeaderEvent }
  | { kind: "ping" };

/** One line of the leader's watch; anything unreadable is dropped rather than wedging the stream. */
export function parseWatchLine(raw: Uint8Array): WatchLine | null {
  try {
    const v = JSON.parse(new TextDecoder().decode(raw)) as Record<
      string,
      unknown
    >;
    if (v.hello === true)
      return {
        kind: "hello",
        head: Number(v.head) || 0,
        gap: v.gap === true,
      };
    if (v.ping === true) return { kind: "ping" };
    if (
      typeof v.seq === "number" &&
      typeof v.type === "string" &&
      typeof v.cluster === "string"
    )
      return {
        kind: "event",
        event: {
          seq: v.seq,
          type: v.type,
          cluster: v.cluster,
          data: (v.data && typeof v.data === "object" ? v.data : {}) as Record<
            string,
            unknown
          >,
        },
      };
  } catch {
    // an unreadable line is nothing to act on
  }
  return null;
}

const LEASE_STATES = new Set<string>(["ok", "not_responding", "fenced"]);

async function memberLeaseChanged(
  clusterId: string,
  clusterName: string,
  serverId: string,
  state: ClusterLeaseState,
): Promise<void> {
  if (!(await setMemberLease(clusterId, serverId, state))) return;
  // A preview never fails over: it reads offline until it is deployed again (#212).
  if (state === "fenced") await markPreviewsOffline(serverId);
  const name = (await getServerById(serverId))?.name ?? "A server";
  const text = await leaseChangeSentence(
    clusterId,
    clusterName,
    name,
    state,
    serverId,
  );
  await recordClusterActivity(clusterId, text);
  // A server that stopped or is back changes which addresses a domain on every server lists.
  syncClusterAnswerDnsSoon(clusterId);
}

export type EventResult = "applied" | "skipped" | "frozen";

/**
 * Applies one event of the leader once: an event at or below the stored sequence is skipped, and the sequence moves
 * in the same step as what it changed, so a restart never applies the same one twice. Frozen by a Deplo move: nothing is applied.
 */
export async function applyLeaderEvent(
  clusterId: string,
  e: LeaderEvent,
  opts: { advance?: boolean } = {},
): Promise<EventResult> {
  if (await instanceFrozen()) return "frozen";
  const cluster = await getClusterById(clusterId);
  if (!cluster || e.cluster !== clusterId || e.seq <= cluster.eventSeq)
    return "skipped";
  const advance = async (extra: { leaderEpoch?: number } = {}) => {
    if (opts.advance === false) return;
    await getDb()
      .update(clustersTable)
      .set({ eventSeq: e.seq, ...extra })
      .where(
        and(eq(clustersTable.id, clusterId), lt(clustersTable.eventSeq, e.seq)),
      );
  };
  const d = e.data;
  switch (e.type) {
    case "epoch": {
      const epoch = Number(d.epoch);
      // Only upward: a leader that led before reports the epoch it left with.
      await advance(
        Number.isInteger(epoch) && epoch > cluster.leaderEpoch
          ? { leaderEpoch: epoch }
          : {},
      );
      return "applied";
    }
    case "member_state": {
      const state = String(d.state);
      if (typeof d.member === "string" && LEASE_STATES.has(state))
        await memberLeaseChanged(
          clusterId,
          cluster.name,
          d.member,
          state as ClusterLeaseState,
        );
      await advance();
      return "applied";
    }
    case "placement": {
      const members = Array.isArray(d.members)
        ? d.members.map((m) => (typeof m === "string" && m ? m : null))
        : [];
      if (
        (d.kind === "app" || d.kind === "database") &&
        typeof d.workloadId === "string"
      ) {
        try {
          await recordPlacement({
            clusterId,
            kind: d.kind,
            workloadId: d.workloadId,
            members,
            epoch: Number(d.epoch) || cluster.leaderEpoch,
          });
        } catch (err) {
          // A placement naming a server that has left is stale; it must not hold up what follows it.
          console.warn(`[cluster-watch] ${clusterId}: ${messageOf(err)}`);
        }
      }
      await advance();
      return "applied";
    }
    case "moving": {
      if (
        d.kind === "app" &&
        typeof d.workloadId === "string" &&
        typeof d.to === "string"
      )
        moveStarted(d.workloadId, d.to);
      await advance();
      return "applied";
    }
    case "member_gone":
    case "member_rejoined": {
      if (typeof d.member === "string") {
        const name = (await getServerById(d.member))?.name ?? "A server";
        await recordClusterActivity(
          clusterId,
          e.type === "member_gone"
            ? `${name} has been gone from cluster ${cluster.name} for 2 minutes, so the others no longer count it for a majority: if another server stops, the last ones keep serving.`
            : `${name} caught up and counts for a majority of cluster ${cluster.name} again.`,
        );
      }
      await advance();
      return "applied";
    }
    case "failed_over": {
      await applyFailedOver(cluster, d);
      await advance();
      return "applied";
    }
    case "move_failed": {
      await applyMoveFailed(cluster, d);
      await advance();
      return "applied";
    }
    case "failover": {
      await applyFailoverSummary(cluster, e.seq, d);
      await advance();
      return "applied";
    }
    case "member_returned": {
      await applyMemberReturned(cluster, e.seq, d);
      await advance();
      return "applied";
    }
    case "left_saved": {
      await applyLeftSaved(cluster, d);
      await advance();
      return "applied";
    }
    case "superseded": {
      await recordClusterActivity(
        clusterId,
        `Cluster ${cluster.name}'s leader stepped down: a server in it follows a newer one.`,
      );
      await advance();
      return "applied";
    }
    default:
      await advance();
      return "applied";
  }
}

/**
 * After a replay: what the leader moved on its own is read back first, then the roster and placement go out, so a
 * mirror that missed a failover never overwrites it. `lost` is the range of events the watch said were dropped.
 */
export async function reconcileCluster(
  clusterId: string,
  lost: { after: number; before: number } | null = null,
): Promise<void> {
  const cluster = await getClusterById(clusterId);
  if (!cluster || (await instanceFrozen())) return;
  const before = (await readLeaderSnapshot(cluster))?.clusters[clusterId];
  if (before) await adoptLeaderMoves(cluster, before, lost);
  forgetLeaderRoster(clusterId);
  await pushLeaderRoster(cluster);
  // A leader that had no roster yet knows the cluster only now.
  const view =
    before ?? (await readLeaderSnapshot(cluster))?.clusters[clusterId];
  if (view) {
    for (const m of view.members)
      if (LEASE_STATES.has(m.state))
        await memberLeaseChanged(
          clusterId,
          cluster.name,
          m.id,
          m.state as ClusterLeaseState,
        );
    if (view.epoch > cluster.leaderEpoch)
      await getDb()
        .update(clustersTable)
        .set({ leaderEpoch: view.epoch })
        .where(eq(clustersTable.id, clusterId));
  }
  // A push the leader missed while the link was down: it must not start the previous release.
  for (const resend of [
    reconcileClusterBundles,
    reconcileClusterDatabaseBundles,
  ])
    await resend(clusterId).catch((e) =>
      console.warn(`[failover-bundle] ${clusterId}: ${messageOf(e)}`),
    );
}

/** Moves the stored sequence up to `seq`, never down. */
async function advanceTo(clusterId: string, seq: number): Promise<void> {
  await getDb()
    .update(clustersTable)
    .set({ eventSeq: seq })
    .where(
      and(eq(clustersTable.id, clusterId), lt(clustersTable.eventSeq, seq)),
    );
}

/**
 * Independent moves are applied side by side, each workload's in order (deplo#244); the sequence moves only once all
 * of them are done, so a restart in between applies again what was not finished.
 */
export class MoveBatch {
  private running = new Map<string, Promise<EventResult>>();
  private highest = 0;
  private failure: unknown = null;
  private frozen = false;
  constructor(
    private clusterId: string,
    private apply: typeof applyLeaderEvent = applyLeaderEvent,
  ) {}

  add(e: LeaderEvent): void {
    const key = `${String(e.data.kind)}/${String(e.data.workloadId)}`;
    const before =
      this.running.get(key) ?? Promise.resolve("applied" as EventResult);
    this.highest = Math.max(this.highest, e.seq);
    this.running.set(
      key,
      before.then(async (r) => {
        if (r === "frozen") return r;
        try {
          const out = await this.apply(this.clusterId, e, {
            advance: false,
          });
          if (out === "frozen") this.frozen = true;
          return out;
        } catch (err) {
          this.failure ??= err;
          return "skipped";
        }
      }),
    );
  }

  /** Waits for every move under way, then stores the sequence: "frozen" when a Deplo move stopped one. */
  async settle(): Promise<"applied" | "frozen"> {
    if (this.running.size === 0) return "applied";
    await Promise.all(this.running.values());
    this.running.clear();
    const failure = this.failure;
    this.failure = null;
    if (failure) throw failure;
    if (this.frozen) return "frozen";
    await advanceTo(this.clusterId, this.highest);
    return "applied";
  }
}

export type WatchEnd = "ended" | "frozen" | "reset" | "no_leader";

/**
 * Opens the watch from the stored sequence and applies every event in order until the stream ends. Once everything
 * up to the leader's newest sequence is applied, the cluster is reconciled. A leader that lost its buffer (its newest
 * sequence is below the stored one) makes the stored sequence start over.
 */
export async function watchClusterOnce(
  clusterId: string,
  signal?: AbortSignal,
): Promise<WatchEnd> {
  const cluster = await getClusterById(clusterId);
  if (!cluster) return "no_leader";
  const host = await leaderHost(cluster);
  if (!host) return "no_leader";
  let seq = cluster.eventSeq;
  let head: number | null = null;
  let reconciled = false;
  // Set when the leader's buffer dropped events this watch never read: what happened in between is in the snapshot.
  let lost: { after: number; before: number } | null = null;
  let sawEvent = false;
  const reconcile = async () => {
    reconciled = true;
    try {
      await reconcileCluster(clusterId, lost);
    } catch (e) {
      console.warn(
        `[cluster-watch] ${clusterId}: could not reconcile: ${messageOf(e)}`,
      );
    }
  };
  const stream = watchClusterLeader(host.id, seq);
  const batch = new MoveBatch(clusterId);
  try {
    for await (const raw of stream) {
      if (signal?.aborted) break;
      const line = parseWatchLine(raw);
      if (!line) continue;
      const move =
        line.kind === "event" &&
        line.event.cluster === clusterId &&
        line.event.type === "failed_over";
      if (move) {
        if (lost && !sawEvent) lost.before = line.event.seq;
        sawEvent = true;
        batch.add(line.event);
        seq = Math.max(seq, line.event.seq);
        if (!reconciled && head !== null && seq >= head) {
          if ((await batch.settle()) === "frozen") return "frozen";
          await reconcile();
        }
        continue;
      }
      // Anything else waits for the moves before it: a placement or summary reads what they changed.
      if ((await batch.settle()) === "frozen") return "frozen";
      if (line.kind === "ping") continue;
      if (line.kind === "hello") {
        if (line.head < seq) {
          await getDb()
            .update(clustersTable)
            .set({ eventSeq: 0 })
            .where(eq(clustersTable.id, clusterId));
          return "reset";
        }
        head = line.head;
        if (line.gap) lost = { after: seq, before: line.head + 1 };
      } else {
        // The first event still in the buffer closes the range that was dropped.
        if (lost && !sawEvent) lost.before = line.event.seq;
        sawEvent = true;
        // Another cluster's event on the same leader applies nothing here; only the position moves.
        if (
          line.event.cluster === clusterId &&
          (await applyLeaderEvent(clusterId, line.event)) === "frozen"
        )
          return "frozen";
        seq = Math.max(seq, line.event.seq);
      }
      if (!reconciled && head !== null && seq >= head) await reconcile();
    }
    if ((await batch.settle()) === "frozen") return "frozen";
  } finally {
    // What was applied before the stream broke keeps its place, so it is not said twice.
    await batch.settle().catch(() => undefined);
    await stream.return(undefined);
  }
  return "ended";
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });

async function currentLeaderHostId(clusterId: string): Promise<string | null> {
  const cluster = await getClusterById(clusterId).catch(() => null);
  return cluster
    ? ((await leaderHost(cluster).catch(() => null))?.id ?? null)
    : null;
}

/** Waits up to `ms`, ending as soon as another server leads the cluster: a takeover is watched at once (deplo#244). */
export async function pauseUnlessLeaderMoves(
  clusterId: string,
  from: string | null,
  ms: number,
  signal: AbortSignal,
): Promise<void> {
  const until = Date.now() + ms;
  while (!signal.aborted && Date.now() < until) {
    await sleep(Math.min(LEADER_CHECK_MS, until - Date.now()), signal);
    if ((await currentLeaderHostId(clusterId)) !== from) return;
  }
}

/** How often a watch that lost its leader looks for the one that takes over. */
export const LEADER_CHECK_MS = 1_000;

/** Keeps a cluster's watch open, reconnecting with a growing pause, until the signal aborts. */
export async function runClusterWatch(
  clusterId: string,
  signal: AbortSignal,
): Promise<void> {
  let pause = 1000;
  let lastMessage = "";
  while (!signal.aborted) {
    const host = await currentLeaderHostId(clusterId);
    try {
      const end = await watchClusterOnce(clusterId, signal);
      lastMessage = "";
      if (end === "no_leader" || end === "frozen")
        await pauseUnlessLeaderMoves(clusterId, host, 15_000, signal);
      else {
        pause = 1000;
        await sleep(end === "reset" ? 0 : 1000, signal);
      }
    } catch (e) {
      const message = messageOf(e);
      if (message !== lastMessage)
        console.warn(`[cluster-watch] ${clusterId}: ${message}`);
      lastMessage = message;
      // A leader's server the leader before declared down is not tried again until the pause, unless another takes over.
      await pauseUnlessLeaderMoves(clusterId, host, pause, signal);
      pause = Math.min(pause * 2, 30_000);
    }
  }
}
