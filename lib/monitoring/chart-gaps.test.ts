import { test } from "node:test";
import assert from "node:assert/strict";

import { GAP_MS, gapSpans, isInGap, visibleGapSpans } from "./chart-gaps";
import { RECONNECT_BACKOFF_CAP_MS } from "./supervisor";

const GAP = 10_000;

test("no gaps in a regular 1s cadence", () => {
  const ts = [0, 1000, 2000, 3000, 4000].map((t) => t);
  assert.deepEqual(gapSpans(ts, GAP), []);
});

test("empty / single-sample inputs have no gaps", () => {
  assert.deepEqual(gapSpans([], GAP), []);
  assert.deepEqual(gapSpans([1000], GAP), []);
});

test("a spacing strictly greater than maxGap is a gap; equal is not", () => {
  assert.deepEqual(gapSpans([0, GAP], GAP), []);
  assert.deepEqual(gapSpans([0, GAP + 1], GAP), [[0, GAP + 1]]);
});

test("finds the deploy-shaped gap in the middle of good data", () => {
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
  assert.equal(isInGap(2000, spans), false);
  assert.equal(isInGap(62_000, spans), false);
  assert.equal(isInGap(30_000, spans), true);
  assert.equal(isInGap(1000, spans), false);
});

test("GAP_MS is derived from the stream cadence + the supervisor's backoff cap, and cannot drift from it", () => {
  const CADENCE_MS = 5_000;
  const worstHealthySpacing = CADENCE_MS + RECONNECT_BACKOFF_CAP_MS;
  assert.ok(
    GAP_MS >= 1.5 * worstHealthySpacing,
    `GAP_MS (${GAP_MS}) must be at least 1.5x the worst healthy spacing ` +
      `(${CADENCE_MS} cadence + ${RECONNECT_BACKOFF_CAP_MS} backoff cap = ${worstHealthySpacing})`,
  );
  assert.deepEqual(gapSpans([0, worstHealthySpacing], GAP_MS), []);
});

test("a hole fully inside the window is banded with its own endpoints", () => {
  const ts = [100_000, 105_000, 195_000, 200_000];
  assert.deepEqual(visibleGapSpans(ts, GAP, 100_000, 200_000), [
    [105_000, 195_000],
  ]);
});

test("a hole straddling the window start is dropped, not half-banded", () => {
  const ts = [100_000, 190_000];
  assert.deepEqual(visibleGapSpans(ts, GAP, 150_000, 200_000), []);
});

test("a hole running past the window end IS clamped to the visible part", () => {
  const ts = [160_000, 400_000];
  assert.deepEqual(visibleGapSpans(ts, GAP, 150_000, 200_000), [
    [160_000, 200_000],
  ]);
});

test("an off-window straggler does NOT band the plot - history just doesn't reach", () => {
  const t1 = 1_000_000;
  const ts = [
    t1 - 840_000,
    ...Array.from({ length: 20 }, (_, i) => t1 - 40_000 + i * 2000),
  ];
  for (const windowMs of [60_000, 300_000]) {
    assert.deepEqual(
      visibleGapSpans(ts, GAP, t1 - windowMs, t1),
      [],
      `a ${windowMs / 60_000}m window must not band the lookbehind straggler`,
    );
  }
  assert.deepEqual(visibleGapSpans(ts, GAP, t1 - 900_000, t1), [
    [t1 - 840_000, t1 - 40_000],
  ]);
});

test("a young buffer (control plane restarted) renders empty, never banded", () => {
  const t1 = 1_000_000;
  const ts = Array.from({ length: 19 }, (_, i) => t1 - 90_000 + i * 5000);
  assert.deepEqual(visibleGapSpans(ts, GAP, t1 - 900_000, t1), []);
});

test("real interior holes still band once the window reaches back to them", () => {
  const t1 = 1_000_000;
  const ts = [t1 - 300_000, t1 - 295_000, t1 - 60_000, t1 - 55_000, t1];
  assert.deepEqual(visibleGapSpans(ts, GAP, t1 - 60_000, t1), [
    [t1 - 55_000, t1],
  ]);
  assert.deepEqual(visibleGapSpans(ts, GAP, t1 - 900_000, t1), [
    [t1 - 295_000, t1 - 60_000],
    [t1 - 55_000, t1],
  ]);
});
