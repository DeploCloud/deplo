export type GapSpan = [startTs: number, endTs: number];

export const GAP_MS = 22_500;

export function gapSpans(timestamps: number[], maxGapMs: number): GapSpan[] {
  const spans: GapSpan[] = [];
  for (let i = 1; i < timestamps.length; i++) {
    const prev = timestamps[i - 1];
    const cur = timestamps[i];
    if (cur - prev > maxGapMs) spans.push([prev, cur]);
  }
  return spans;
}

export function visibleGapSpans(
  timestamps: number[],
  maxGapMs: number,
  windowStart: number,
  windowEnd: number,
): GapSpan[] {
  const spans: GapSpan[] = [];
  for (const [a, b] of gapSpans(timestamps, maxGapMs)) {
    if (a <= windowStart) continue;
    const hi = Math.min(b, windowEnd);
    if (hi > a) spans.push([a, hi]);
  }
  return spans;
}

export function isInGap(ts: number, spans: GapSpan[]): boolean {
  return spans.some(([a, b]) => ts > a && ts < b);
}
