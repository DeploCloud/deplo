import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  CONTAINER_HISTORY_WINDOW_MS,
  recordContainerSample,
  getContainerHistory,
  latestContainerSampleTs,
  clearContainerHistory,
  pruneContainerHistoryTo,
  markContainerWatched,
  watchedContainerTargets,
  clearContainerWatches,
} from "./container-history";
import type { ContainerMetricsSample } from "../data/container-metrics";

/**
 * The per-app / per-database metrics ring buffer (container-history.ts): keyed
 * by id, online-samples-only, min-gap dedupe, window eviction, and the clear /
 * prune paths the Save-metrics-off switch and the collector rely on.
 */

// Read-time eviction is relative to Date.now(), so tests use near-now timestamps.
const NOW = Date.now();

function sample(id: string, ts: number, over: Partial<ContainerMetricsSample> = {}): ContainerMetricsSample {
  return {
    id,
    online: true,
    ts,
    cpu: 1,
    memUsed: 1,
    memLimit: 10,
    memPct: 10,
    netRx: 0,
    netTx: 0,
    blockRead: 0,
    blockWrite: 0,
    pids: 1,
    running: 1,
    containers: 1,
    ...over,
  };
}

beforeEach(() => {
  clearContainerHistory();
  clearContainerWatches();
});

test("records online samples per id and reads them back oldest-first", () => {
  recordContainerSample(sample("app_1", NOW - 4000));
  recordContainerSample(sample("app_1", NOW - 2000));
  recordContainerSample(sample("app_2", NOW - 3500));

  const a = getContainerHistory("app_1");
  assert.deepEqual(a.map((s) => s.ts), [NOW - 4000, NOW - 2000]);
  assert.equal(getContainerHistory("app_2").length, 1);
  assert.equal(latestContainerSampleTs("app_1"), NOW - 2000);
  assert.equal(latestContainerSampleTs("missing"), 0);
});

test("refuses offline snapshots (a gap, not a fake zero)", () => {
  recordContainerSample(sample("app_1", NOW - 4000, { online: false }));
  assert.equal(getContainerHistory("app_1").length, 0);
});

test("dedupes samples landing within the min gap (multiple viewers)", () => {
  recordContainerSample(sample("app_1", NOW - 4000));
  recordContainerSample(sample("app_1", NOW - 3700)); // within 700ms → dropped
  recordContainerSample(sample("app_1", NOW - 2000));
  assert.deepEqual(getContainerHistory("app_1").map((s) => s.ts), [NOW - 4000, NOW - 2000]);
});

test("evicts samples older than the window", () => {
  recordContainerSample(sample("app_1", NOW - CONTAINER_HISTORY_WINDOW_MS - 5000)); // stale
  recordContainerSample(sample("app_1", NOW));
  const kept = getContainerHistory("app_1");
  assert.equal(kept.length, 1);
  assert.equal(kept[0].ts, NOW);
});

test("clearContainerHistory drops one id (the Save-metrics-off switch)", () => {
  recordContainerSample(sample("app_1", NOW - 4000));
  recordContainerSample(sample("app_2", NOW - 4000));
  clearContainerHistory("app_1");
  assert.equal(getContainerHistory("app_1").length, 0);
  assert.equal(getContainerHistory("app_2").length, 1);
});

test("pruneContainerHistoryTo keeps only the opted-in set (the collector)", () => {
  recordContainerSample(sample("app_1", NOW - 4000));
  recordContainerSample(sample("app_2", NOW - 4000));
  recordContainerSample(sample("db_1", NOW - 4000));
  pruneContainerHistoryTo(new Set(["app_1", "db_1"]));
  assert.equal(getContainerHistory("app_1").length, 1);
  assert.equal(getContainerHistory("app_2").length, 0);
  assert.equal(getContainerHistory("db_1").length, 1);
});

/* ------------------------------------------------------------------ */
/* Recently-watched set — history for resources with save_metrics OFF  */
/* ------------------------------------------------------------------ */

test("a watched resource becomes a collector target, with its owning server", () => {
  markContainerWatched("app_1", "srv_a", NOW);
  assert.deepEqual(watchedContainerTargets(NOW), [{ id: "app_1", serverId: "srv_a" }]);
});

test("the watch survives long enough to cover the widest chart window", () => {
  // The point of the TTL: navigate away, come back inside the window, and the
  // collector has kept sampling — so the chart is continuous instead of holed.
  markContainerWatched("app_1", "srv_a", NOW);
  const stillWatched = watchedContainerTargets(NOW + CONTAINER_HISTORY_WINDOW_MS - 1000);
  assert.deepEqual(stillWatched, [{ id: "app_1", serverId: "srv_a" }]);
});

test("an expired watch is forgotten, so sampling stops when nobody is looking", () => {
  markContainerWatched("app_1", "srv_a", NOW);
  assert.deepEqual(watchedContainerTargets(NOW + CONTAINER_HISTORY_WINDOW_MS + 1), []);
  // ...and stays forgotten (the expiry prunes the map, not just the result).
  assert.deepEqual(watchedContainerTargets(NOW), []);
});

test("re-polling refreshes the TTL rather than stacking entries", () => {
  markContainerWatched("app_1", "srv_a", NOW);
  markContainerWatched("app_1", "srv_a", NOW + CONTAINER_HISTORY_WINDOW_MS - 1000);
  const targets = watchedContainerTargets(NOW + CONTAINER_HISTORY_WINDOW_MS + 500);
  assert.deepEqual(targets, [{ id: "app_1", serverId: "srv_a" }]);
});

test("a watched resource moved to another server dials the new one", () => {
  markContainerWatched("app_1", "srv_a", NOW);
  markContainerWatched("app_1", "srv_b", NOW + 1000);
  assert.deepEqual(watchedContainerTargets(NOW + 1000), [
    { id: "app_1", serverId: "srv_b" },
  ]);
});
