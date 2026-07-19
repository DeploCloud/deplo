import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  CONTAINER_HISTORY_WINDOW_MS,
  recordContainerSample,
  getContainerHistory,
  latestContainerSample,
  latestContainerSampleTs,
  latestContainerInstances,
  recordContainerInstances,
  clearContainerHistory,
  pruneContainerHistoryTo,
} from "./container-history";
import type {
  ContainerInstanceMetrics,
  ContainerMetricsSample,
} from "../data/container-metrics";

/**
 * The per-app / per-database metrics ring buffer (container-history.ts): keyed
 * by id, online-samples-only, rate-ceiling, window eviction, the clear / prune
 * paths, and the separate latest-value CELL that holds the per-container
 * breakdown.
 *
 * The watch-set tests that used to live here are gone with the API. Under the
 * telemetry stream every Deplo-managed container on a host arrives in one frame,
 * so "which resources are we willing to pay to sample?" is no longer a question
 * this module answers — see the supervisor.
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

function instance(name: string, over: Partial<ContainerInstanceMetrics> = {}): ContainerInstanceMetrics {
  return {
    name,
    running: true,
    cpu: 1,
    memUsed: 1,
    memLimit: 10,
    memPct: 10,
    netRx: 0,
    netTx: 0,
    blockRead: 0,
    blockWrite: 0,
    pids: 1,
    ...over,
  };
}

beforeEach(() => {
  clearContainerHistory();
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

test("latestContainerSample returns the newest point (what a live read serves)", () => {
  assert.equal(latestContainerSample("app_1"), null);
  recordContainerSample(sample("app_1", NOW - 4000, { cpu: 7 }));
  recordContainerSample(sample("app_1", NOW - 2000, { cpu: 9 }));
  assert.equal(latestContainerSample("app_1")?.cpu, 9);
});

test("refuses offline snapshots (a gap, not a fake zero)", () => {
  recordContainerSample(sample("app_1", NOW - 4000, { online: false }));
  assert.equal(getContainerHistory("app_1").length, 0);
});

test("drops samples landing inside the rate ceiling (MIN_GAP_MS = 250)", () => {
  // A ceiling, not a de-dupe: it sits BELOW the agent's 1s cadence clamp floor,
  // so a legitimately fast host is never thinned — only a pathological writer is.
  recordContainerSample(sample("app_1", NOW - 4000));
  recordContainerSample(sample("app_1", NOW - 3900)); // 100ms later → dropped
  recordContainerSample(sample("app_1", NOW - 3700)); // 300ms after the kept one → kept
  assert.deepEqual(
    getContainerHistory("app_1").map((s) => s.ts),
    [NOW - 4000, NOW - 3700],
  );
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

test("pruneContainerHistoryTo keeps only ids that still EXIST", () => {
  recordContainerSample(sample("app_1", NOW - 4000));
  recordContainerSample(sample("app_2", NOW - 4000));
  recordContainerSample(sample("db_1", NOW - 4000));
  pruneContainerHistoryTo(new Set(["app_1", "db_1"]));
  assert.equal(getContainerHistory("app_1").length, 1);
  assert.equal(getContainerHistory("app_2").length, 0);
  assert.equal(getContainerHistory("db_1").length, 1);
});

/* ------------------------------------------------------------------ */
/* Absence is a gap, never a reason to forget                          */
/* ------------------------------------------------------------------ */

test("a container absent from a frame RETAINS its buffered window", () => {
  // The behavioural change from the poll era, and the reason it matters: a
  // container that STOPPED is exactly when its trailing window is worth the
  // most — the operator opens the tab to see the CPU spike or the memory climb
  // that PRECEDED the stop. Pruning on absence would erase the evidence at the
  // moment it became interesting.
  recordContainerSample(sample("app_1", NOW - 10_000, { cpu: 95 })); // the spike
  recordContainerSample(sample("app_1", NOW - 5000, { cpu: 98 }));
  recordContainerSample(sample("app_2", NOW - 5000)); // a sibling, still running

  // Two subsequent frames carry app_2 only — app_1 died. Nothing prunes it.
  recordContainerSample(sample("app_2", NOW - 2000));
  recordContainerSample(sample("app_2", NOW));

  assert.deepEqual(
    getContainerHistory("app_1").map((s) => s.cpu),
    [95, 98],
    "the window preceding the stop must survive the container's disappearance",
  );
  // Only DELETION of the resource forgets it — that is what prune is for.
  pruneContainerHistoryTo(new Set(["app_2"]));
  assert.equal(getContainerHistory("app_1").length, 0);
});

/* ------------------------------------------------------------------ */
/* The breakdown CELL — a live table, not a series                     */
/* ------------------------------------------------------------------ */

test("the breakdown starts empty and is a per-resource cell", () => {
  assert.deepEqual(latestContainerInstances("app_1"), []);
  recordContainerInstances("app_1", [instance("web")]);
  assert.deepEqual(latestContainerInstances("app_1").map((i) => i.name), ["web"]);
  assert.deepEqual(latestContainerInstances("app_2"), []);
});

test("recordContainerInstances REPLACES the cell, never appends", () => {
  // The whole point of keeping this out of the ring buffer: nobody charts the
  // breakdown, so it needs no history — and appending would multiply every
  // sample by the container count, which is what toSample strips it out to avoid.
  recordContainerInstances("app_1", [instance("web"), instance("worker")]);
  recordContainerInstances("app_1", [instance("web")]); // the worker was removed
  assert.deepEqual(latestContainerInstances("app_1").map((i) => i.name), ["web"]);

  recordContainerInstances("app_1", []); // the whole stack went down
  assert.deepEqual(latestContainerInstances("app_1"), []);
});

test("clearContainerHistory clears the breakdown cell too, per id and wholesale", () => {
  // OFF must mean nothing stays saved. A cleared buffer beside a stale breakdown
  // table would leave the tab rendering last week's containers under an empty chart.
  recordContainerSample(sample("app_1", NOW));
  recordContainerInstances("app_1", [instance("web")]);
  recordContainerInstances("app_2", [instance("db")]);

  clearContainerHistory("app_1");
  assert.deepEqual(latestContainerInstances("app_1"), []);
  assert.deepEqual(latestContainerInstances("app_2").map((i) => i.name), ["db"]);

  clearContainerHistory();
  assert.deepEqual(latestContainerInstances("app_2"), []);
});
