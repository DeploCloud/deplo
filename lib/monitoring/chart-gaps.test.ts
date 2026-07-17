import { test } from "node:test";
import assert from "node:assert/strict";

import { gapSpans, isInGap } from "./chart-gaps";

/**
 * Gap detection for the monitoring charts (chart-gaps.ts): which stretches of
 * the time axis have no measurements, so the chart can band them "No data".
 */

const GAP = 10_000; // matches the chart's GAP_MS

test("no gaps in a regular 1s cadence", () => {
  const ts = [0, 1000, 2000, 3000, 4000].map((t) => t);
  assert.deepEqual(gapSpans(ts, GAP), []);
});

test("empty / single-sample inputs have no gaps", () => {
  assert.deepEqual(gapSpans([], GAP), []);
  assert.deepEqual(gapSpans([1000], GAP), []);
});

test("a spacing strictly greater than maxGap is a gap; equal is not", () => {
  // exactly maxGap apart => still connected (mirrors segment threshold)
  assert.deepEqual(gapSpans([0, GAP], GAP), []);
  // one ms over => a gap span with the exact endpoints
  assert.deepEqual(gapSpans([0, GAP + 1], GAP), [[0, GAP + 1]]);
});

test("finds the deploy-shaped gap in the middle of good data", () => {
  // 1s samples, then a ~1 minute hole (agent busy deploying), then resume.
  const ts = [0, 1000, 2000, 62_000, 63_000, 64_000];
  assert.deepEqual(gapSpans(ts, GAP), [[2000, 62_000]]);
});

test("finds multiple independent gaps", () => {
  const ts = [0, 1000, 30_000, 31_000, 90_000];
  assert.deepEqual(gapSpans(ts, GAP), [
    [1000, 30_000],
    [31_000, 90_000],
  ]);
});

test("isInGap is strict-interior: endpoints (real samples) are not in the gap", () => {
  const spans = gapSpans([2000, 62_000], GAP);
  assert.equal(isInGap(2000, spans), false); // the last good sample
  assert.equal(isInGap(62_000, spans), false); // the first sample after
  assert.equal(isInGap(30_000, spans), true); // mid-hole
  assert.equal(isInGap(1000, spans), false); // before the gap
});
