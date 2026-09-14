// Offline snapshots are never recorded (the history buffers refuse them), so a gap is only ever a widened spacing.

// A half-open-in-spirit interval [startTs, endTs] with no measurements between.
export type GapSpan = [startTs: number, endTs: number];

// GAP_MS: the spacing above which a hole is a FAILURE, not cadence jitter - shared by charts, segmenter and bands.
export const GAP_MS = 22_500;

// gapSpans: spans whose delta STRICTLY exceeds `maxGapMs`; `timestamps` must be ascending.
export function gapSpans(timestamps: number[], maxGapMs: number): GapSpan[] {
  const spans: GapSpan[] = [];
  for (let i = 1; i < timestamps.length; i++) {
    const prev = timestamps[i - 1];
    const cur = timestamps[i];
    if (cur - prev > maxGapMs) spans.push([prev, cur]);
  }
  return spans;
}

// visibleGapSpans: the spans a chart should actually BAND, clamped to the window it is showing.
export function visibleGapSpans(
  timestamps: number[],
  maxGapMs: number,
  windowStart: number,
  windowEnd: number,
): GapSpan[] {
  const spans: GapSpan[] = [];
  for (const [a, b] of gapSpans(timestamps, maxGapMs)) {
    // Starts at/before the window: "history doesn't reach here", not a failure.
    if (a <= windowStart) continue;
    // `a` is inside the window by the guard above; only the tail needs clamping.
    const hi = Math.min(b, windowEnd);
    if (hi > a) spans.push([a, hi]);
  }
  return spans;
}

// True when `ts` falls strictly inside a gap span - the chart answers a hover with "No data".
export function isInGap(ts: number, spans: GapSpan[]): boolean {
  return spans.some(([a, b]) => ts > a && ts < b);
}
