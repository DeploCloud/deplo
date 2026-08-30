import { test } from "node:test";
import assert from "node:assert/strict";

import {
  arcPath,
  areaPath,
  downsample,
  gaugeFraction,
  linePath,
} from "./chart-geometry";

test("downsample thins to the asked length and keeps the newest sample", () => {
  const pts = Array.from({ length: 900 }, (_, i) => i);
  const out = downsample(pts, 30);
  assert.equal(out.length, 30);
  assert.equal(out[0], 0);
  // The last point is the one printed as the current value beside the spark.
  assert.equal(out[29], 899);
});

test("downsample leaves a series shorter than the target alone", () => {
  assert.deepEqual(downsample([1, 2, 3], 30), [1, 2, 3]);
  assert.deepEqual(downsample([], 30), []);
  assert.deepEqual(downsample([1, 2, 3], 0), []);
});

test("gaugeFraction refuses to invent a reading without a ceiling", () => {
  assert.equal(gaugeFraction(50, 100), 0.5);
  // Over the ceiling pins the arc full rather than drawing past it.
  assert.equal(gaugeFraction(299, 100), 1);
  // An unknown ceiling (0 cores before the first frame) draws nothing.
  assert.equal(gaugeFraction(50, 0), 0);
  assert.equal(gaugeFraction(Number.NaN, 100), 0);
  assert.equal(gaugeFraction(-5, 100), 0);
});

test("arcPath flips the large-arc flag past a half turn", () => {
  // A 240deg gauge sweep is more than half a circle: the flag has to be 1 or the
  // full arc renders as the short way round.
  assert.match(arcPath(50, 50, 40, -120, 120), /A40,40 0 1 1/);
  assert.match(arcPath(50, 50, 40, -120, 0), /A40,40 0 0 1/);
  assert.equal(arcPath(50, 50, 40, 0, 0), "");
});

test("areaPath closes the run down to the baseline", () => {
  const d = areaPath(
    [
      { x: 0, y: 10 },
      { x: 5, y: 4 },
    ],
    20,
  );
  assert.equal(d, "M0.00,20.00L0.00,10.00L5.00,4.00L5.00,20.00Z");
  assert.equal(linePath([{ x: 1, y: 2 }]), "M1.00,2.00");
});
