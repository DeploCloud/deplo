/**
 * Gap detection for the monitoring time-series charts. Offline snapshots are never
 * recorded (server + container history refuse them), so a gap shows up here purely
 * as a widened spacing between real samples.
 */

/** A half-open-in-spirit interval [startTs, endTs] with no measurements between. */
export type GapSpan = [startTs: number, endTs: number];

/**
 * The spacing above which a hole is a FAILURE rather than ordinary cadence jitter -
 * the single threshold the charts, the line segmenter and the bands all share.
 */
export const GAP_MS = 22_500;

/**
 * The spans between consecutive `timestamps` whose delta STRICTLY exceeds
 * `maxGapMs`. `timestamps` must be ascending (the chart's sample buffer already
 * is).
 */
export function gapSpans(timestamps: number[], maxGapMs: number): GapSpan[] {
  const spans: GapSpan[] = [];
  for (let i = 1; i < timestamps.length; i++) {
    const prev = timestamps[i - 1];
    const cur = timestamps[i];
    if (cur - prev > maxGapMs) spans.push([prev, cur]);
  }
  return spans;
}

/**
 * The gap spans a chart should actually BAND, given the window it is showing. Two
 * corrections over raw {@link gapSpans}, both of which stop the chart from
 * claiming a failure it cannot know about: - **Clamped to the window.
 */
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

/** True when `ts` falls strictly inside one of the gap spans (the chart uses
 *  this to answer a hover with "No data" instead of the nearest real sample). */
export function isInGap(ts: number, spans: GapSpan[]): boolean {
  return spans.some(([a, b]) => ts > a && ts < b);
}
