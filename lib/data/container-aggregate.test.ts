// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from "node:test";
import assert from "node:assert/strict";

import type { ContainerStat } from "../agent/gen/agent";
import { aggregateContainerStats } from "./container-metrics";

/**
 * The fold from one host frame to one stack's numbers. Its own file because it is
 * pure: no database, no identity, no buffer.
 */

const HOST = { memTotal: 23.42 * 1024 ** 3, cpuCores: 8 };

function stat(name: string, over: Partial<ContainerStat> = {}): ContainerStat {
  return {
    name,
    cpuPct: 0,
    memUsed: 0,
    memLimit: HOST.memTotal, // what the agent sends for an UNCAPPED container
    memPct: 0,
    netRx: 0,
    netTx: 0,
    blockRead: 0,
    blockWrite: 0,
    pids: 1,
    running: true,
    projectId: "prj_1",
    containerId: `cid_${name}`,
    state: "running",
    health: "",
    restartCount: 0,
    netNsId: 0,
    netNsHost: false,
    ...over,
  };
}

// Summing each container's limit reported 50.3 GB of ceiling on a 23.42 GiB host,
// and moved the denominator with the RUNNING COUNT: stopping one container of a
// stack changed its memory percentage without the usage changing at all.
test("the memory ceiling is the machine, counted once and unmoved by a stop", () => {
  const two = aggregateContainerStats(
    "prj_1",
    [stat("web", { memUsed: 800 }), stat("worker", { memUsed: 200 })],
    1,
    HOST,
  );
  assert.equal(two.memLimit, HOST.memTotal);
  assert.equal(two.memUsed, 1000);

  // The worker stops. Usage falls by its share; the CEILING does not move.
  const one = aggregateContainerStats(
    "prj_1",
    [
      stat("web", { memUsed: 800 }),
      stat("worker", { running: false, state: "exited" }),
    ],
    2,
    HOST,
  );
  assert.equal(one.memLimit, two.memLimit, "the machine did not get smaller");
  assert.equal(one.containers, 2, "a stopped container is still in the stack");
  assert.equal(one.running, 1);
});

// The clamp is what keeps a hand-written `mem_limit` meaningful: those caps are
// real budgets, and only the agent's "uncapped means the whole machine" needs
// collapsing.
test("real per-container caps are still the budget when they are smaller", () => {
  const cap = 512 * 1024 ** 2;
  const agg = aggregateContainerStats(
    "prj_1",
    [
      stat("web", { memLimit: cap, memUsed: 100 }),
      stat("worker", { memLimit: cap, memUsed: 100 }),
    ],
    1,
    HOST,
  );
  assert.equal(agg.memLimit, 2 * cap);
});

// A compose sidecar on `network_mode: service:x` reads the SAME
// /proc/<pid>/net/dev as the container it joined, so summing the stack counted
// every byte twice.
test("containers sharing a network namespace contribute one counter", () => {
  const agg = aggregateContainerStats(
    "prj_1",
    [
      stat("app", { netNsId: 4026532001, netRx: 500, netTx: 100 }),
      stat("vpn-sidecar", { netNsId: 4026532001, netRx: 500, netTx: 100 }),
    ],
    1,
    HOST,
  );
  assert.equal(agg.netRx, 500, "the shared namespace was counted twice");
  assert.equal(agg.netTx, 100);
  // Everything that is genuinely per-container still sums.
  assert.equal(agg.pids, 2);
});

test("separate namespaces still both count", () => {
  const agg = aggregateContainerStats(
    "prj_1",
    [
      stat("a", { netNsId: 1, netRx: 500 }),
      stat("b", { netNsId: 2, netRx: 300 }),
    ],
    1,
    HOST,
  );
  assert.equal(agg.netRx, 800);
});

// An agent too old to report a namespace cannot prove anything is shared, so
// every container counts for itself exactly as it did before the field existed.
test("no namespace id falls back to per-container counting", () => {
  const agg = aggregateContainerStats(
    "prj_1",
    [stat("a", { netRx: 500 }), stat("b", { netRx: 300 })],
    1,
    HOST,
  );
  assert.equal(agg.netRx, 800);
});

// `network_mode: host` reads the WHOLE MACHINE's counters - an idle container
// reported 51 GB that way. Those bytes belong to the server's own chart.
test("a host-networked container adds no traffic to its stack", () => {
  const agg = aggregateContainerStats(
    "prj_1",
    [
      stat("app", { netNsId: 7, netRx: 500 }),
      stat("vpn", { netNsHost: true, netRx: 51_000_000_000, memUsed: 40 }),
    ],
    1,
    HOST,
  );
  assert.equal(agg.netRx, 500);
  // It is still part of the stack for everything else.
  assert.equal(agg.running, 2);
  assert.equal(agg.memUsed, 40);
});

// `cpu` is a percentage of ONE core, so the tab needs the machine's core count
// to also read it as "3.0 of 8 cores".
test("the frame's core count rides along with the sample", () => {
  const agg = aggregateContainerStats(
    "prj_1",
    [stat("web", { cpuPct: 299 })],
    1,
    HOST,
  );
  assert.equal(agg.cpu, 299);
  assert.equal(agg.hostCores, 8);
});

test("a stack with nothing running measures zero, not a fabricated ceiling", () => {
  const agg = aggregateContainerStats(
    "prj_1",
    [stat("web", { running: false, state: "exited" })],
    1,
    HOST,
  );
  assert.equal(agg.running, 0);
  assert.equal(agg.memUsed, 0);
  assert.equal(agg.memPct, 0);
});
