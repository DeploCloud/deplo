// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Pure geometry for the monitoring charts. Kept out of the client components so
 * the maths is testable with `node --test` - the components stay presentation.
 */

export interface XY {
  x: number;
  y: number;
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** A polyline through one gap-free run of screen coordinates. */
export function linePath(seg: readonly XY[]): string {
  return seg
    .map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(2)},${p.y.toFixed(2)}`)
    .join("");
}

/** The same run closed down to `baseY`, so a gradient has something to fill. */
export function areaPath(seg: readonly XY[], baseY: number): string {
  const first = seg[0];
  const last = seg[seg.length - 1];
  return (
    `M${first.x.toFixed(2)},${baseY.toFixed(2)}` +
    seg.map((p) => `L${p.x.toFixed(2)},${p.y.toFixed(2)}`).join("") +
    `L${last.x.toFixed(2)},${baseY.toFixed(2)}Z`
  );
}

/**
 * Thin a series to at most `n` points on an even stride, ALWAYS keeping the
 * newest one - a sparkline that drops its last sample lags the number printed
 * next to it, which reads as a bug rather than as thinning.
 */
export function downsample<T>(pts: readonly T[], n: number): T[] {
  if (n <= 0) return [];
  if (pts.length <= n) return [...pts];
  const stride = (pts.length - 1) / (n - 1);
  const out: T[] = [];
  for (let i = 0; i < n - 1; i++) out.push(pts[Math.round(i * stride)]);
  out.push(pts[pts.length - 1]);
  return out;
}

/**
 * How much of a gauge's sweep a reading fills, 0..1. `full` is the honest ceiling
 * for that reading: a configured cap, or the whole machine when there is none.
 */
export function gaugeFraction(value: number, full: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(full) || full <= 0) return 0;
  return clamp(value / full, 0, 1);
}

/** Point on a circle. 0deg is 12 o'clock, angles run clockwise. */
function onCircle(cx: number, cy: number, r: number, deg: number): XY {
  const rad = ((deg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

/** An open arc from `startDeg` to `endDeg`, clockwise. Empty when it has no sweep. */
export function arcPath(
  cx: number,
  cy: number,
  r: number,
  startDeg: number,
  endDeg: number,
): string {
  const sweep = endDeg - startDeg;
  if (sweep <= 0) return "";
  const a = onCircle(cx, cy, r, startDeg);
  const b = onCircle(cx, cy, r, Math.min(endDeg, startDeg + 359.99));
  const large = sweep > 180 ? 1 : 0;
  return `M${a.x.toFixed(2)},${a.y.toFixed(2)}A${r},${r} 0 ${large} 1 ${b.x.toFixed(2)},${b.y.toFixed(2)}`;
}
