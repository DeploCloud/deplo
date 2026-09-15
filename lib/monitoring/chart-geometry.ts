export interface XY {
  x: number;
  y: number;
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

export function linePath(seg: readonly XY[]): string {
  return seg
    .map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(2)},${p.y.toFixed(2)}`)
    .join("");
}

export function areaPath(seg: readonly XY[], baseY: number): string {
  const first = seg[0];
  const last = seg[seg.length - 1];
  return (
    `M${first.x.toFixed(2)},${baseY.toFixed(2)}` +
    seg.map((p) => `L${p.x.toFixed(2)},${p.y.toFixed(2)}`).join("") +
    `L${last.x.toFixed(2)},${baseY.toFixed(2)}Z`
  );
}

export function downsample<T>(pts: readonly T[], n: number): T[] {
  if (n <= 0) return [];
  if (pts.length <= n) return [...pts];
  const stride = (pts.length - 1) / (n - 1);
  const out: T[] = [];
  for (let i = 0; i < n - 1; i++) out.push(pts[Math.round(i * stride)]);
  out.push(pts[pts.length - 1]);
  return out;
}

export function gaugeFraction(value: number, full: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(full) || full <= 0) return 0;
  return clamp(value / full, 0, 1);
}

function onCircle(cx: number, cy: number, r: number, deg: number): XY {
  const rad = ((deg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

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
