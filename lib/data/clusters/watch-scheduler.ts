import "server-only";

import { randomBytes } from "node:crypto";
import { hostname } from "node:os";

import { getDb } from "../../db/client";
import { clusters as clustersTable } from "../../db/schema/control-plane/clusters";
import { acquireLease, releaseLease } from "../../backups/lease";
import { instanceFrozen } from "../deplo-move/freeze";
import { runEmptyingPass } from "./empty";
import { leaderHost } from "./host";
import { superviseClusterLeader } from "./leader-standby";
import { pushLeaderRoster } from "./leader-sync";
import { getClusterById } from "./roster";
import { runClusterWatch } from "./watch";

// Starts a watch on every cluster's leader and keeps the leader's roster current; one Deplo instance holds the lease.
export const CLUSTER_WATCH_LEASE = "cluster-watch";

const TICK_MS = 15_000;

interface State {
  started: boolean;
  timer: ReturnType<typeof setInterval> | null;
  owner: string;
  ticking: boolean;
  watches: Map<string, AbortController>;
  /** The server whose leader each watch was opened on. */
  leading?: Map<string, string>;
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
      !(await acquireLease(CLUSTER_WATCH_LEASE, state.owner, new Date()))
    ) {
      stopAll();
      return;
    }
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
        console.warn(
          `[cluster-leader] ${id}: ${e instanceof Error ? e.message : String(e)}`,
        ),
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
      if (cluster)
        await pushLeaderRoster(cluster, { onlyIfChanged: true }).catch(
          () => false,
        );
    }
    // Not awaited: one move can outlast many ticks, and a pass already running is joined, not doubled.
    void runEmptyingPass().catch((e) =>
      console.error("[deplo] emptying a cluster member failed:", e),
    );
  } catch (e) {
    console.error("[deplo] cluster watch tick failed:", e);
  } finally {
    state.ticking = false;
  }
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
}

export async function releaseClusterWatchLease(): Promise<void> {
  stopAll();
  await releaseLease(CLUSTER_WATCH_LEASE, state.owner);
}

/** Test seam: forget every running watch. */
export function __resetClusterWatchForTest(): void {
  stopAll();
  state.started = false;
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
}
