import test from "node:test";
import assert from "node:assert/strict";
import {
  baseSize,
  clampView,
  cropRect,
  initialView,
  maxZoom,
  panBy,
  zoomTo,
  type CropSource,
} from "./crop-geometry";

const cover = (width: number, height: number): CropSource => ({
  width,
  height,
  mode: "cover",
});
const fit = (width: number, height: number): CropSource => ({
  width,
  height,
  mode: "fit",
});

test("cover at zoom 1 reproduces the old blind centre crop", () => {
  // The regression pin: someone who opens the dialog and saves without touching
  // anything gets byte-for-byte what `toAvatarDataUri` used to produce.
  const s = cover(800, 600);
  assert.deepEqual(cropRect(initialView(s), s), { sx: 100, sy: 0, size: 600 });
});

test("fit at zoom 1 contains the whole picture, source rect going negative", () => {
  const s = fit(1200, 400);
  assert.deepEqual(cropRect(initialView(s), s), {
    sx: 0,
    sy: -400,
    size: 1200,
  });
});

test("cover clamps the crop square inside the picture", () => {
  const s = cover(800, 600);
  const left = clampView({ cx: 0, cy: 300, zoom: 1 }, s);
  assert.equal(left.cx, 300);
  const right = clampView({ cx: 1e9, cy: 300, zoom: 1 }, s);
  assert.equal(right.cx, 500);
});

test("a padded axis is pinned to the middle", () => {
  const s = fit(1200, 400);
  const v = clampView({ cx: 0, cy: 1e9, zoom: 1 }, s);
  assert.deepEqual({ cx: v.cx, cy: v.cy }, { cx: 600, cy: 200 });
});

test("zoom floors at 1 - the circle can never go transparent", () => {
  const s = cover(800, 600);
  const v = zoomTo(initialView(s), s, 0.2);
  assert.equal(v.zoom, 1);
  const r = cropRect(v, s);
  assert.ok(r.sx >= 0 && r.sy >= 0);
});

test("zoom ceilings, and a 1x1 picture has nowhere to go", () => {
  const big = cover(800, 600);
  assert.equal(zoomTo(initialView(big), big, 999).zoom, maxZoom(big));
  assert.equal(maxZoom(big), 8);

  const tiny = cover(1, 1);
  assert.equal(maxZoom(tiny), 1);
  const r = cropRect(initialView(tiny), tiny);
  assert.deepEqual(r, { sx: 0, sy: 0, size: 1 });
  assert.ok(Number.isFinite(r.size));
});

test("pan round-trips inside the bounds and saturates outside them", () => {
  const s = cover(800, 600);
  const start = zoomTo(initialView(s), s, 2);
  const there = panBy(start, s, 10, 0, 320);
  const back = panBy(there, s, -10, 0, 320);
  assert.ok(Math.abs(back.cx - start.cx) < 1e-9);
  assert.equal(panBy(start, s, -1e6, 0, 320).cx, 800 - baseSize(s) / 2 / 2);
});

test("anchored zoom holds the point under the pointer", () => {
  const s = cover(4000, 4000);
  const v = zoomTo(initialView(s), s, 2, 0, 0);
  const r = cropRect(v, s);
  assert.equal(r.sx, 0);
  assert.equal(r.sy, 0);
});

test("cover: the crop square never leaves the picture, at any zoom", () => {
  for (const [w, h] of [
    [800, 600],
    [600, 800],
    [1000, 1000],
    [3, 7],
    [8000, 6000],
  ]) {
    const s = cover(w, h);
    for (const zoom of [1, 1.5, 3, 8]) {
      const r = cropRect(zoomTo(initialView(s), s, zoom), s);
      assert.ok(r.size > 0, `${w}x${h} @${zoom}: empty crop`);
      assert.ok(
        r.sx >= -1e-9 && r.sy >= -1e-9,
        `${w}x${h} @${zoom}: negative source`,
      );
      assert.ok(
        r.sx + r.size <= w + 1e-9 && r.sy + r.size <= h + 1e-9,
        `${w}x${h} @${zoom}: crop runs past the edge`,
      );
    }
  }
});

test("fit: the whole picture is inside the crop square at zoom 1", () => {
  for (const [w, h] of [
    [800, 600],
    [600, 800],
    [1000, 1000],
    [1200, 400],
    [3, 7],
  ]) {
    const s = fit(w, h);
    const r = cropRect(initialView(s), s);
    assert.ok(
      r.sx <= 1e-9 && r.sy <= 1e-9,
      `${w}x${h}: picture starts outside`,
    );
    assert.ok(
      r.sx + r.size >= w - 1e-9 && r.sy + r.size >= h - 1e-9,
      `${w}x${h}: picture ends outside`,
    );
  }
});
