// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from "node:test";
import assert from "node:assert/strict";

import { POLL_MS, pollIntervalFor } from "./dashboard-parts";

/**
 * The dashboards read an in-RAM buffer on a timer. A fixed 1s timer returned the
 * frame already on screen four times out of five at the agent's 5s default - the
 * cost of watching, per viewer, which is the axis the telemetry stream exists to
 * keep flat.
 */

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
  // Half of 1s is under the floor, so the floor wins: a fast host must not be
  // rendered slower than it reports.
  assert.equal(pollIntervalFor(at(1000)), POLL_MS);
});

test("a slow cadence is capped so the 'as of' clock keeps moving", () => {
  assert.equal(pollIntervalFor(at(60_000)), 10_000);
});

// A reconnect leaves one wide gap in an otherwise steady series; the median is
// what stops that gap from slowing every viewer down for the next 16 minutes.
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
