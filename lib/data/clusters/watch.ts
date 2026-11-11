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
  const text =
    state === "ok"
      ? `${name} answers again in cluster ${clusterName}.`
      : state === "not_responding"
        ? `${name} is not responding in cluster ${clusterName}.`
        : `${name} has not responded for a minute in cluster ${clusterName}, so it stopped the databases and Apps with files that must never run twice.`;
  await recordClusterActivity(clusterId, text);
}

export type EventResult = "applied" | "skipped" | "frozen";

/**
 * Applies one event of the leader once: an event at or below the stored sequence is skipped, and the sequence moves
 * in the same step as what it changed, so a restart never applies the same one twice. Frozen by a Deplo move: nothing is applied.
 */
export async function applyLeaderEvent(
  clusterId: string,
  e: LeaderEvent,
): Promise<EventResult> {
  if (await instanceFrozen()) return "frozen";
  const cluster = await getClusterById(clusterId);
  if (!cluster || e.cluster !== clusterId || e.seq <= cluster.eventSeq)
    return "skipped";
  const advance = async (extra: { leaderEpoch?: number } = {}) => {
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
  try {
    for await (const raw of stream) {
      if (signal?.aborted) break;
      const line = parseWatchLine(raw);
      if (!line || line.kind === "ping") continue;
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
  } finally {
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

/** Keeps a cluster's watch open, reconnecting with a growing pause, until the signal aborts. */
export async function runClusterWatch(
  clusterId: string,
  signal: AbortSignal,
): Promise<void> {
  let pause = 1000;
  let lastMessage = "";
  while (!signal.aborted) {
    try {
      const end = await watchClusterOnce(clusterId, signal);
      lastMessage = "";
      if (end === "no_leader" || end === "frozen") await sleep(15_000, signal);
      else {
        pause = 1000;
        await sleep(end === "reset" ? 0 : 1000, signal);
      }
    } catch (e) {
      const message = messageOf(e);
      if (message !== lastMessage)
        console.warn(`[cluster-watch] ${clusterId}: ${message}`);
      lastMessage = message;
      await sleep(pause, signal);
      pause = Math.min(pause * 2, 30_000);
    }
  }
}
