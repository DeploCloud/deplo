import { test } from "node:test";
import assert from "node:assert/strict";

import { GAP_MS, gapSpans, isInGap, visibleGapSpans } from "./chart-gaps";

/**
 * Gap detection for the monitoring charts (chart-gaps.ts): which stretches of
 * the time axis have no measurements, so the chart can band them "No data".
 */

const GAP = 10_000; // a round threshold for the raw-span cases below

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

/* ------------------------------------------------------------------ */
/* The threshold                                                       */
/* ------------------------------------------------------------------ */

test("GAP_MS clears the slowest healthy cadence with real headroom", () => {
  // The background collector ticks every 5s and its `ticking` guard may skip one
  // beat, so ~10s between two healthy samples is normal — measured worst case on
  // a live 3-server fleet was 5.64s, and a skipped tick doubles that. The
  // threshold must sit ABOVE that or an untroubled server bands itself.
  const worstHealthySpacing = 2 * 5_000 + 1_000; // skipped tick + latency jitter
  assert.ok(
    GAP_MS > worstHealthySpacing,
    `GAP_MS (${GAP_MS}) must exceed the worst healthy spacing (${worstHealthySpacing})`,
  );
  assert.deepEqual(gapSpans([0, worstHealthySpacing], GAP_MS), []);
});

/* ------------------------------------------------------------------ */
/* visibleGapSpans — what the chart actually bands                     */
/* ------------------------------------------------------------------ */

test("a hole fully inside the window is banded with its own endpoints", () => {
  // 5s cadence, then a 90s hole (the host was pinned by its own deploy).
  const ts = [100_000, 105_000, 195_000, 200_000];
  assert.deepEqual(visibleGapSpans(ts, GAP, 100_000, 200_000), [[105_000, 195_000]]);
});

test("a hole straddling the window start is dropped, not half-banded", () => {
  // The window opens mid-hole. We cannot tell a real outage from a buffer that
  // simply doesn't reach back that far, so the honest render is empty plot.
  const ts = [100_000, 190_000];
  assert.deepEqual(visibleGapSpans(ts, GAP, 150_000, 200_000), []);
});

test("a hole running past the window end IS clamped to the visible part", () => {
  // Starts inside the window, so it is an observed hole; only its tail is cut.
  const ts = [160_000, 400_000];
  assert.deepEqual(visibleGapSpans(ts, GAP, 150_000, 200_000), [[160_000, 200_000]]);
});

test("an off-window straggler does NOT band the plot — history just doesn't reach", () => {
  // The regression that made "No data" look random: the chart draws one sample
  // from before the window so the line can enter from the left edge. With a lone
  // 14-minute-old straggler plus dense recent data, the raw span covered ~87% of
  // a 5m plot — claiming a failure across a stretch the window never showed.
  const t1 = 1_000_000;
  const ts = [t1 - 840_000, ...Array.from({ length: 20 }, (_, i) => t1 - 40_000 + i * 2000)];
  for (const windowMs of [60_000, 300_000]) {
    assert.deepEqual(
      visibleGapSpans(ts, GAP, t1 - windowMs, t1),
      [],
      `a ${windowMs / 60_000}m window must not band the lookbehind straggler`,
    );
  }
  // ...but once the window is wide enough to actually CONTAIN the straggler, the
  // 13-minute hole after it is a real observed hole and must still be banded.
  // Honesty is preserved; only the off-window claim is dropped.
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
  // The honesty invariant: widening the window must reveal genuine holes.
  const t1 = 1_000_000;
  const ts = [t1 - 300_000, t1 - 295_000, t1 - 60_000, t1 - 55_000, t1];
  // The 1m window opens exactly on a sample, so the 235s hole before it is
  // pre-history and dropped — but the 55s hole inside the window is banded.
  assert.deepEqual(visibleGapSpans(ts, GAP, t1 - 60_000, t1), [[t1 - 55_000, t1]]);
  // Widen, and the earlier hole comes into view as well.
  assert.deepEqual(visibleGapSpans(ts, GAP, t1 - 900_000, t1), [
    [t1 - 295_000, t1 - 60_000],
    [t1 - 55_000, t1],
  ]);
});
