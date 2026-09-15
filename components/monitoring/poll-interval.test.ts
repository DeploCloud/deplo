import { test } from "node:test";
import assert from "node:assert/strict";

import { POLL_MS, pollIntervalFor } from "./dashboard-parts";

function at(cadenceMs: number, n = 6): number[] {
  return Array.from({ length: n }, (_, i) => 1_000_000 + i * cadenceMs);
}

test("no samples yet falls back to the floor", () => {
  assert.equal(pollIntervalFor([]), POLL_MS);
  assert.equal(pollIntervalFor([1_000_000]), POLL_MS);
});

test("the default 5s cadence is read twice per sample, not five times", () => {
  assert.equal(pollIntervalFor(at(5000)), 2500);
});

test("a host reporting every second is still read every second", () => {
  assert.equal(pollIntervalFor(at(1000)), POLL_MS);
});

test("a slow cadence is capped so the 'as of' clock keeps moving", () => {
  assert.equal(pollIntervalFor(at(60_000)), 10_000);
});

test("one outlier gap does not move the cadence", () => {
  const ts = at(5000);
  ts.push(ts[ts.length - 1] + 45_000);
  ts.push(ts[ts.length - 1] + 5000);
  assert.equal(pollIntervalFor(ts), 2500);
});

test("duplicate timestamps are ignored rather than collapsing the interval", () => {
  const ts = [1_000_000, 1_000_000, 1_005_000, 1_010_000, 1_015_000];
  assert.equal(pollIntervalFor(ts), 2500);
});
