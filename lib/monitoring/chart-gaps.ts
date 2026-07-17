/**
 * Gap detection for the monitoring time-series charts.
 *
 * A "gap" is a stretch of the time axis with NO measurements — two consecutive
 * samples spaced further apart than `maxGapMs`. It happens whenever the sampling
 * pipeline couldn't record an online sample for a while: the owning server was
 * busy deploying (a buildkit export saturates its agent), the agent went
 * unreachable, or the viewer tab was backgrounded and throttled. Offline
 * snapshots are never recorded (server + container history refuse them), so a
 * gap shows up here purely as a widened spacing between real samples.
 *
 * The chart uses these spans to draw an explicit "No data" band instead of an
 * invisible break in the line, so an operator never reads a genuine measurement
 * gap as a rendering glitch or a dip to zero.
 *
 * Pure and framework-free (no `server-only`, no React, no DOM) so it is safe to
 * import from the client chart AND unit-testable under `node --test`.
 */

/** A half-open-in-spirit interval [startTs, endTs] with no measurements between. */
export type GapSpan = [startTs: number, endTs: number];

/**
 * The spans between consecutive `timestamps` whose delta STRICTLY exceeds
 * `maxGapMs`. `timestamps` must be ascending (the chart's sample buffer already
 * is). A pair exactly `maxGapMs` apart is not a gap — it matches the chart's own
 * line-segmenting threshold so bands line up with where the line breaks.
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

/** True when `ts` falls strictly inside one of the gap spans (the chart uses
 *  this to answer a hover with "No data" instead of the nearest real sample). */
export function isInGap(ts: number, spans: GapSpan[]): boolean {
  return spans.some(([a, b]) => ts > a && ts < b);
}
