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
  recordMemberSample,
  dropMemberSamples,
  freshMemberIds,
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

const share = (serverId: string, s: ContainerMetricsSample) => ({
  serverId,
  cpu: s.cpu,
  memUsed: s.memUsed,
  running: s.running,
});

test("one server's readings are the workload's history, value for value", () => {
  const first = sample("app_1", NOW - 5000, { cpu: 7, netRx: 900 });
  // A restarted container counts from zero again, and the history shows it as it does today.
  const second = sample("app_1", NOW, { cpu: 9, netRx: 40 });
  recordMemberSample("srv_a", first, [instance("web")]);
  recordMemberSample("srv_a", second, [instance("web")]);
  assert.deepEqual(getContainerHistory("app_1"), [
    { ...first, members: [share("srv_a", first)] },
    { ...second, members: [share("srv_a", second)] },
  ]);
  assert.deepEqual(latestContainerInstances("app_1"), [instance("web")]);
});

test("two servers' readings total on the first server's tick, with each one's share", () => {
  const a = sample("app_1", NOW - 5000, {
    cpu: 10,
    memUsed: 100,
    memLimit: 1000,
    pids: 3,
    hostCores: 4,
  });
  const b = sample("app_1", NOW - 4000, {
    cpu: 30,
    memUsed: 300,
    memLimit: 1000,
    pids: 5,
    hostCores: 2,
  });
  recordMemberSample("srv_a", a, [instance("web-1")]);
  recordMemberSample("srv_b", b, [instance("web-1")]);
  assert.equal(getContainerHistory("app_1").length, 1, "srv_b does not lead");

  const a2 = { ...a, ts: NOW, cpu: 20 };
  recordMemberSample("srv_a", a2, [instance("web-1")]);
  const total = getContainerHistory("app_1").at(-1)!;
  assert.deepEqual(
    {
      ts: total.ts,
      cpu: total.cpu,
      memUsed: total.memUsed,
      memLimit: total.memLimit,
      memPct: total.memPct,
      pids: total.pids,
      running: total.running,
      containers: total.containers,
      hostCores: total.hostCores,
      members: total.members,
    },
    {
      ts: NOW,
      cpu: 50,
      memUsed: 400,
      memLimit: 2000,
      memPct: 20,
      pids: 8,
      running: 2,
      containers: 2,
      hostCores: 6,
      members: [share("srv_a", a2), share("srv_b", b)],
    },
  );
  assert.deepEqual(
    latestContainerInstances("app_1").map((i) => [i.name, i.serverId]),
    [
      ["web-1", "srv_a"],
      ["web-1", "srv_b"],
    ],
  );
});

test("a server joining the total adds what it sends from then on, never its counter so far", () => {
  const at = (ago: number, netRx: number) =>
    sample("app_1", NOW - ago, { netRx });
  recordMemberSample("srv_a", at(10_000, 1000), []);
  recordMemberSample("srv_b", at(9000, 5_000_000), []);
  recordMemberSample("srv_a", at(5000, 1100), []);
  recordMemberSample("srv_b", at(4000, 5_000_300), []);
  recordMemberSample("srv_a", at(0, 1200), []);
  assert.deepEqual(
    getContainerHistory("app_1").map((s) => s.netRx),
    [1000, 1100, 1500],
  );
});

test("a server silent past the fresh window leaves the total, and the next one leads", () => {
  recordMemberSample("srv_a", sample("app_1", NOW - 30_000, { cpu: 10 }), []);
  recordMemberSample("srv_b", sample("app_1", NOW - 29_000, { cpu: 30 }), []);
  recordMemberSample("srv_b", sample("app_1", NOW - 24_000, { cpu: 31 }), []);
  assert.equal(getContainerHistory("app_1").length, 1, "srv_a still leads");
  const alone = sample("app_1", NOW - 14_000, { cpu: 32 });
  recordMemberSample("srv_b", alone, []);
  const last = getContainerHistory("app_1").at(-1)!;
  assert.equal(last.cpu, 32);
  assert.deepEqual(last.members, [share("srv_b", alone)]);
  assert.deepEqual(freshMemberIds("app_1", NOW - 14_000), ["srv_b"]);
  assert.deepEqual(freshMemberIds("app_1", NOW + 60_000), []);
});

test("a server whose frame no longer carries the workload leaves the total at once", () => {
  recordMemberSample("srv_a", sample("app_1", NOW - 5000, { cpu: 10 }), []);
  recordMemberSample("srv_b", sample("app_1", NOW - 4000, { cpu: 30 }), []);
  recordMemberSample("srv_a", sample("app_2", NOW - 4000), []);
  dropMemberSamples("srv_a", new Set(["app_2"]));
  recordMemberSample("srv_b", sample("app_1", NOW, { cpu: 31 }), []);
  assert.equal(getContainerHistory("app_1").at(-1)!.cpu, 31);
  assert.deepEqual(freshMemberIds("app_2", NOW), ["srv_a"]);
});

test("clearing or pruning a workload forgets its servers too", () => {
  recordMemberSample("srv_a", sample("app_1", NOW - 5000), []);
  recordMemberSample("srv_b", sample("app_1", NOW - 4000), []);
  clearContainerHistory("app_1");
  assert.deepEqual(freshMemberIds("app_1", NOW), []);
  recordMemberSample("srv_b", sample("app_1", NOW), []);
  assert.equal(getContainerHistory("app_1").length, 1, "srv_b leads alone");
  pruneContainerHistoryTo(new Set());
  assert.deepEqual(freshMemberIds("app_1", NOW), []);
});
