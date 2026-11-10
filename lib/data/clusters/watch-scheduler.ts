import "server-only";

import { randomBytes } from "node:crypto";
import { hostname } from "node:os";

import { getDb } from "../../db/client";
import { clusters as clustersTable } from "../../db/schema/control-plane/clusters";
import { acquireLease, releaseLease } from "../../backups/lease";
import { instanceFrozen } from "../deplo-move/freeze";
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
    for (const id of ids) {
      if (!state.watches.has(id)) {
        const c = new AbortController();
        state.watches.set(id, c);
        void runClusterWatch(id, c.signal);
      }
      const cluster = await getClusterById(id);
      if (cluster)
        await pushLeaderRoster(cluster, { onlyIfChanged: true }).catch(
          () => false,
        );
    }
  } catch (e) {
    console.error("[deplo] cluster watch tick failed:", e);
  } finally {
    state.ticking = false;
  }
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
