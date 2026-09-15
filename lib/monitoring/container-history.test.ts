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

const NOW = Date.now();

function sample(
  id: string,
  ts: number,
  over: Partial<ContainerMetricsSample> = {},
): ContainerMetricsSample {
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
    hostCores: 8,
    ...over,
  };
}

function instance(
  name: string,
  over: Partial<ContainerInstanceMetrics> = {},
): ContainerInstanceMetrics {
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
    state: "running",
    health: "",
    restartCount: 0,
    netNsId: 0,
    netNsHost: false,
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
  assert.deepEqual(
    a.map((s) => s.ts),
    [NOW - 4000, NOW - 2000],
  );
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
  recordContainerSample(sample("app_1", NOW - 4000));
  recordContainerSample(sample("app_1", NOW - 3900));
  recordContainerSample(sample("app_1", NOW - 3700));
  assert.deepEqual(
    getContainerHistory("app_1").map((s) => s.ts),
    [NOW - 4000, NOW - 3700],
  );
});

test("evicts samples older than the window", () => {
  recordContainerSample(
    sample("app_1", NOW - CONTAINER_HISTORY_WINDOW_MS - 5000),
  );
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

test("a container absent from a frame RETAINS its buffered window", () => {
  recordContainerSample(sample("app_1", NOW - 10_000, { cpu: 95 }));
  recordContainerSample(sample("app_1", NOW - 5000, { cpu: 98 }));
  recordContainerSample(sample("app_2", NOW - 5000));

  recordContainerSample(sample("app_2", NOW - 2000));
  recordContainerSample(sample("app_2", NOW));

  assert.deepEqual(
    getContainerHistory("app_1").map((s) => s.cpu),
    [95, 98],
    "the window preceding the stop must survive the container's disappearance",
  );
  pruneContainerHistoryTo(new Set(["app_2"]));
  assert.equal(getContainerHistory("app_1").length, 0);
});

test("the breakdown starts empty and is a per-resource cell", () => {
  assert.deepEqual(latestContainerInstances("app_1"), []);
  recordContainerInstances("app_1", [instance("web")]);
  assert.deepEqual(
    latestContainerInstances("app_1").map((i) => i.name),
    ["web"],
  );
  assert.deepEqual(latestContainerInstances("app_2"), []);
});

test("recordContainerInstances REPLACES the cell, never appends", () => {
  recordContainerInstances("app_1", [instance("web"), instance("worker")]);
  recordContainerInstances("app_1", [instance("web")]);
  assert.deepEqual(
    latestContainerInstances("app_1").map((i) => i.name),
    ["web"],
  );

  recordContainerInstances("app_1", []);
  assert.deepEqual(latestContainerInstances("app_1"), []);
});

test("clearContainerHistory clears the breakdown cell too, per id and wholesale", () => {
  recordContainerSample(sample("app_1", NOW));
  recordContainerInstances("app_1", [instance("web")]);
  recordContainerInstances("app_2", [instance("db")]);

  clearContainerHistory("app_1");
  assert.deepEqual(latestContainerInstances("app_1"), []);
  assert.deepEqual(
    latestContainerInstances("app_2").map((i) => i.name),
    ["db"],
  );

  clearContainerHistory();
  assert.deepEqual(latestContainerInstances("app_2"), []);
});
