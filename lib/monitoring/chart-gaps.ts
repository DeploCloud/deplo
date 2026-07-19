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
 * The spacing above which a hole is a FAILURE rather than ordinary cadence
 * jitter — the single threshold the charts, the line segmenter and the bands all
 * share.
 *
 * It has to clear the slowest HEALTHY producer, not the fastest. Under the
 * telemetry STREAM (lib/monitoring/supervisor.ts) there is exactly one producer
 * per host — the agent's own ticker — which removes the old multi-writer
 * arithmetic entirely. Two terms remain:
 *
 *   - the sampling cadence: 5s, the agent's default `interval_ms`;
 *   - the reconnect backoff CAP: 10s. A stream can drop for reasons that are not
 *     a host failure at all — a deadline rotation, an agent self-update, a NAT
 *     rebalance — and the supervisor's backoff means the worst HEALTHY case is
 *     one cadence plus one full backoff step before the next frame lands.
 *
 * So the worst healthy spacing is 5s + 10s = 15s, and the threshold is that with
 * the same 50% headroom the poll-era value carried: 22.5s.
 *
 * DERIVATION ORDER MATTERS: the backoff cap is the input, not the output. If you
 * change `RECONNECT_BACKOFF_CAP_MS` in the supervisor, this constant must move
 * with it, and `chart-gaps.test.ts` asserts exactly that relationship so the two
 * cannot silently drift apart.
 *
 * Getting this wrong is not cosmetic and has bitten three times already
 * (commits 05ebd6a, 81c8239, d0c7bd9): too low bands a host that never missed a
 * beat — the "random No data" bug — while too high hides a real outage behind a
 * connected line. The previous 15s value was derived from a poll model whose
 * every premise (a viewer's ~2s busy-guarded poll, a 5s collector that could slip
 * a beat, `ts` stamped at RPC completion) no longer exists.
 */
export const GAP_MS = 22_500;

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

/**
 * The gap spans a chart should actually BAND, given the window it is showing.
 *
 * Two corrections over raw {@link gapSpans}, both of which stop the chart from
 * claiming a failure it cannot know about:
 *
 *  - **Clamped to the window.** A span is trimmed to `[windowStart, windowEnd]`,
 *    so a hole that began before the window contributes only its visible part.
 *
 *  - **The leading edge is NOT a gap.** The chart draws one sample from *before*
 *    the window so the line can enter from the left edge; when that lookbehind
 *    sample is far older than the window start, the raw span between it and the
 *    first in-window sample covers most of the plot. But that stretch is not a
 *    measured failure — it is simply where the ring buffer no longer reaches
 *    (a control-plane restart, an evicted window, a resource whose history only
 *    started when someone opened its tab). Rendering "No data" there reads as a
 *    defect in a fleet that was online the whole time. A span that starts at or
 *    before `windowStart` is therefore dropped: unknown history renders as empty
 *    plot, and only holes the buffer genuinely straddles get banded.
 *
 * `timestamps` must be ascending.
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
