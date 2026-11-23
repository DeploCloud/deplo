import "server-only";

import { randomBytes } from "node:crypto";
import { hostname } from "node:os";

import { getDb } from "../../db/client";
import { clusters as clustersTable } from "../../db/schema/control-plane/clusters";
import { acquireLease, releaseLease } from "../../backups/lease";
import { instanceFrozen } from "../deplo-move/freeze";
import { rehomeFailoverBackups } from "../databases/failover";
import { shipChangeLogs } from "./change-log";
import { runClusterRollout } from "./binary-rollout";
import { syncAnsweringClusters } from "./forwarders";
import { reconcileClusterNetworks } from "./network";
import { reconcileClusterZones } from "./dns-zone";
import { runEmptyingPass } from "./empty";
import { reconcileClusterImages } from "./images";
import { runLoadBalancingPass } from "./load-balancing";
import { runReplicationPass } from "./replication";
import { leaderHost } from "./host";
import { BEAT_EVERY_MS, beatClusterLeaders } from "./leader-beat";
import { keepLeadersHome } from "./leader-move";
import { superviseClusterLeader } from "./leader-standby";
import { pushLeaderRoster } from "./leader-sync";
import { settleProvisioningMembers } from "./member-ready";
import { getClusterById } from "./roster";
import { refreshAllClusterWarnings } from "./warnings";
import { runClusterWatch } from "./watch";
import { messageOf } from "../../utils";
import { joinWaitingServers } from "./join-requests";

// Starts a watch on every cluster's leader and keeps the leader's roster current; one Deplo instance holds the lease.
export const CLUSTER_WATCH_LEASE = "cluster-watch";

const TICK_MS = 15_000;
const CHANGE_LOG_EVERY_MS = 60_000;
const ROLLOUT_EVERY_MS = 60_000;
const LEADER_HOME_EVERY_MS = 60_000;
const IMAGES_EVERY_MS = 2 * 60_000;
const NETWORK_EVERY_MS = 2 * 60_000;
// A cluster's DNS zone (ADR-0049): each agent keeps answering on its own; this hands over what changed and reads back.
const ZONE_EVERY_MS = 60_000;
const WARNINGS_EVERY_MS = 30_000;
const BALANCE_EVERY_MS = 30_000;
// How soon a server's turned-away visitors reach Activity (ADR-0048).
const ANSWERS_EVERY_MS = 2 * 60_000;
// Renewed every tick: a Deplo that died without letting go must not leave failover off for the usual 2h.
export const CLUSTER_WATCH_STALE_MS = 5 * 60_000;

interface State {
  started: boolean;
  timer: ReturnType<typeof setInterval> | null;
  owner: string;
  ticking: boolean;
  watches: Map<string, AbortController>;
  /** The server whose leader each watch was opened on. */
  leading?: Map<string, string>;
  /** When the change logs were last collected. */
  changeLogAt?: number;
  /** When the last rollout pass over the cluster binaries started. */
  rolledAt?: number;
  homedAt?: number;
  /** When the clusters that pass domains on were last asked what they turned away. */
  answersAt?: number;
  /** When failed or missing image copies were last retried. */
  imagesAt?: number;
  /** When every cluster's private network was last put right, and whether a pass still runs. */
  networkAt?: number;
  networking?: boolean;
  zoneAt?: number;
  zoning?: boolean;
  /** When the clusters' warnings were last worked out, and whether a pass still runs. */
  warningsAt?: number;
  warning?: boolean;
  /** When the most available server of each load-balanced App was last chosen. */
  balancedAt?: number;
  /** Whether this Deplo held the watch lease at its last tick: only that one names the leaders. */
  holds?: boolean;
  beatTimer?: ReturnType<typeof setInterval> | null;
}

const KEY = Symbol.for("deplo.cluster.watch");
const g = globalThis as unknown as { [KEY]?: State };
const state: State = (g[KEY] ??= {
  started: false,
  timer: null,
  owner: `${hostname()}:${process.pid}:${randomBytes(4).toString("hex")}`,
  ticking: false,
  watches: new Map(),
});

function stopAll(): void {
  for (const c of state.watches.values()) c.abort();
  state.watches.clear();
}

export async function runClusterWatchTick(): Promise<void> {
  if (state.ticking) return;
  state.ticking = true;
  try {
    if (
      (await instanceFrozen()) ||
      !(await acquireLease(
        CLUSTER_WATCH_LEASE,
        state.owner,
        new Date(),
        CLUSTER_WATCH_STALE_MS,
      ))
    ) {
      state.holds = false;
      stopAll();
      return;
    }
    state.holds = true;
    // A server added from inside a cluster joins it once it is installed.
    await joinWaitingServers().catch((e) =>
      console.warn(`[cluster] waiting joins: ${messageOf(e)}`),
    );
    const ids = (
      await getDb().select({ id: clustersTable.id }).from(clustersTable)
    ).map((r) => r.id);
    for (const [id, c] of state.watches)
      if (!ids.includes(id)) {
        c.abort();
        state.watches.delete(id);
      }
    const leading = (state.leading ??= new Map());
    for (const id of ids) {
      await superviseClusterLeader(id).catch((e) =>
        console.warn(`[cluster-leader] ${id}: ${messageOf(e)}`),
      );
      const cluster = await getClusterById(id);
      const host = (cluster && (await leaderHost(cluster))?.id) || "";
      // Another leader leads now: the watch on the old one has nothing more to say.
      if (state.watches.has(id) && leading.get(id) !== host) {
        state.watches.get(id)!.abort();
        state.watches.delete(id);
      }
      if (!state.watches.has(id)) {
        const c = new AbortController();
        state.watches.set(id, c);
        leading.set(id, host);
        void runClusterWatch(id, c.signal);
      }
      if (cluster) {
        await pushLeaderRoster(cluster, { onlyIfChanged: true }).catch(
          () => false,
        );
        // A server that just joined stops reading Provisioning once the leader answers for it.
        await settleProvisioningMembers(cluster).catch(() => 0);
      }
      // A member back online takes the failover backup now, not at the 12-hour sweep.
      await rehomeFailoverBackups(id).catch((e) =>
        console.warn(`[failover-backup] ${id}: ${messageOf(e)}`),
      );
    }
    // Not awaited: one move can outlast many ticks, and a pass already running is joined, not doubled.
    void runEmptyingPass().catch((e) =>
      console.error("[deplo] emptying a cluster member failed:", e),
    );
    // Once a minute, which is what "about a minute" of a Postgres failover rests on.
    if (Date.now() - (state.changeLogAt ?? 0) >= CHANGE_LOG_EVERY_MS) {
      state.changeLogAt = Date.now();
      void shipChangeLogs().catch((e) =>
        console.error("[deplo] collecting a change log failed:", e),
      );
    }
    // Each replicated App says itself when its next copy is due; a pass still running is not doubled.
    void runReplicationPass().catch((e) =>
      console.error("[replication] pass failed:", e),
    );
    if (Date.now() - (state.balancedAt ?? 0) >= BALANCE_EVERY_MS) {
      state.balancedAt = Date.now();
      void runLoadBalancingPass(ids).catch((e) =>
        console.error("[load-balancing] pass failed:", e),
      );
    }
    // A copy that failed while a member was away retries within minutes, not at the 12-hour sweep.
    if (Date.now() - (state.imagesAt ?? 0) >= IMAGES_EVERY_MS) {
      state.imagesAt = Date.now();
      void reconcileClusterImages().catch((e) =>
        console.error("[cluster-images] retrying copies failed:", e),
      );
    }
    // A server whose agent just learned the network joins it, and the Servers page shows each pair's path as it is now.
    if (
      !state.networking &&
      Date.now() - (state.networkAt ?? 0) >= NETWORK_EVERY_MS
    ) {
      state.networkAt = Date.now();
      state.networking = true;
      void reconcileClusterNetworks()
        .catch((e) => console.error("[cluster-network] pass failed:", e))
        .finally(() => (state.networking = false));
    }
    if (!state.zoning && Date.now() - (state.zoneAt ?? 0) >= ZONE_EVERY_MS) {
      state.zoneAt = Date.now();
      state.zoning = true;
      void reconcileClusterZones()
        .catch((e) => console.error("[cluster-zone] pass failed:", e))
        .finally(() => (state.zoning = false));
    }
    // The Servers page reads what this stored, so it never waits on a leader.
    if (
      !state.warning &&
      Date.now() - (state.warningsAt ?? 0) >= WARNINGS_EVERY_MS
    ) {
      state.warningsAt = Date.now();
      state.warning = true;
      void refreshAllClusterWarnings()
        .catch((e) => console.error("[cluster-warnings] pass failed:", e))
        .finally(() => (state.warning = false));
    }
    if (Date.now() - (state.answersAt ?? 0) >= ANSWERS_EVERY_MS) {
      state.answersAt = Date.now();
      void syncAnsweringClusters().catch((e) =>
        console.error("[cluster-forwarders] answering clusters failed:", e),
      );
    }
    // A cluster's leader lives on one of its servers, and each member next in line runs a leader of its own.
    if (Date.now() - (state.homedAt ?? 0) >= LEADER_HOME_EVERY_MS) {
      state.homedAt = Date.now();
      void keepLeadersHome(ids).catch((e) =>
        console.error("[cluster-leader] placing leaders failed:", e),
      );
    }
    if (Date.now() - (state.rolledAt ?? 0) >= ROLLOUT_EVERY_MS) {
      state.rolledAt = Date.now();
      void runClusterRollout().catch((e) =>
        console.error("[deplo] cluster rollout failed:", e),
      );
    }
  } catch (e) {
    console.error("[deplo] cluster watch tick failed:", e);
  } finally {
    state.ticking = false;
  }
}

/** One beat to every leader, from the Deplo that holds the watch. */
export async function runClusterBeat(): Promise<void> {
  if (!state.holds) return;
  await beatClusterLeaders().catch((e) =>
    console.error("[deplo] naming the cluster leaders failed:", e),
  );
}

/** A deleted cluster's watch ends now, not at the next tick. */
export function stopClusterWatch(clusterId: string): void {
  state.watches.get(clusterId)?.abort();
  state.watches.delete(clusterId);
  state.leading?.delete(clusterId);
}

export function startClusterWatch(): void {
  if (state.started) return;
  state.started = true;
  void runClusterWatchTick();
  state.timer = setInterval(() => void runClusterWatchTick(), TICK_MS);
  state.timer.unref?.();
  state.beatTimer = setInterval(() => void runClusterBeat(), BEAT_EVERY_MS);
  state.beatTimer.unref?.();
}

export async function releaseClusterWatchLease(): Promise<void> {
  state.holds = false;
  stopAll();
  await releaseLease(CLUSTER_WATCH_LEASE, state.owner);
}

/** Test seam: forget every running watch. */
export function __resetClusterWatchForTest(): void {
  stopAll();
  state.started = false;
  state.changeLogAt = 0;
  state.rolledAt = 0;
  state.homedAt = 0;
  state.imagesAt = 0;
  state.warningsAt = 0;
  state.warning = false;
  state.balancedAt = 0;
  state.holds = false;
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
  if (state.beatTimer) clearInterval(state.beatTimer);
  state.beatTimer = null;
}
