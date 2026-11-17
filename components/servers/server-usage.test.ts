import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { usageTotals } from "./server-usage";

const GB = 1e9;

test("a cluster's totals count only the servers that answered, CPU weighted by cores", () => {
  const t = usageTotals([
    {
      cpu: 10,
      cores: 8,
      memUsed: 4 * GB,
      memTotal: 16 * GB,
      diskUsed: 50 * GB,
      diskTotal: 200 * GB,
    },
    {
      cpu: 40,
      cores: 2,
      memUsed: 1 * GB,
      memTotal: 4 * GB,
      diskUsed: 10 * GB,
      diskTotal: 50 * GB,
    },
    null,
  ]);
  assert.equal(t.cores, 10);
  assert.equal(t.cpu, 16);
  assert.equal(t.memUsed, 5 * GB);
  assert.equal(t.memTotal, 20 * GB);
  assert.equal(t.diskTotal, 250 * GB);
});

test("a cluster with nobody answering reads as empty, never as divided by zero", () => {
  assert.deepEqual(usageTotals([null, null]), {
    cores: 0,
    cpu: 0,
    memUsed: 0,
    memTotal: 0,
    diskUsed: 0,
    diskTotal: 0,
  });
});

test("usageTotals stays callable from the servers page, which renders on the server", () => {
  const src = readFileSync("components/servers/server-usage.tsx", "utf8");
  assert.ok(!src.startsWith('"use client"'));
});
