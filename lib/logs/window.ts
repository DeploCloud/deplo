/**
 * The time window a log stream is opened with, parsed off the SSE request.
 *
 * The browser sends how far back it wants in MINUTES and the server turns that
 * into an absolute instant on its own clock. Deliberately not an absolute
 * timestamp from the client: `docker logs --since` is evaluated against the
 * HOST's clock, and a viewer whose laptop is a few minutes off would silently
 * ask for the wrong window — a bug that looks exactly like an app that went
 * quiet. A duration means the same thing on every clock.
 *
 * The ceiling is the instance's `logMaxDays`. Clamped, never rejected: the
 * control is a picker with these exact bounds, so a value outside them arrived
 * from something other than the UI, and answering with the ceiling beats a 400
 * about a number nobody chose.
 */

export const MINUTES_PER_DAY = 24 * 60;

export interface LogWindow {
  /** Unix SECONDS, or 0 for "no lower bound" — the agent's own "unset". */
  sinceUnix: number;
  /** Prefix each line with its RFC3339Nano write time. */
  timestamps: boolean;
}

export function parseLogWindow(
  params: URLSearchParams,
  maxDays: number,
  nowMs: number = Date.now(),
): LogWindow {
  const timestamps =
    params.get("timestamps") === "1" || params.get("timestamps") === "true";

  const raw = params.get("sinceMinutes");
  // Absent means "the caller did not ask for a window", which must NOT parse as
  // 0: `Number(null)` is a finite 0, and 0 minutes ago is an empty stream. The
  // same trap the `tail` parser in the routes documents.
  const parsed = raw !== null ? Number(raw) : NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return { sinceUnix: 0, timestamps };
  }

  const ceiling = Math.max(1, Math.trunc(maxDays)) * MINUTES_PER_DAY;
  const minutes = Math.min(Math.trunc(parsed), ceiling);
  return {
    sinceUnix: Math.floor(nowMs / 1000) - minutes * 60,
    timestamps,
  };
}

/**
 * `docker logs --timestamps` prefixes every line with an RFC3339Nano instant and
 * a single space:
 *
 *   2026-08-24T16:23:39.267596474Z {"level":"info","msg":"listening on :3000"}
 *
 * Split it back off. The viewer shows it in its own gutter, and leaving it inline
 * would both waste thirty columns of every row and hand the level detector a date
 * it has to look past. Docker writes the prefix ahead of the raw line, so this
 * matches before any ANSI the producer emitted.
 */
const TIMESTAMP_PREFIX =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\s([\s\S]*)$/;

export function splitTimestamp(line: string): {
  ts: string | null;
  rest: string;
} {
  const m = TIMESTAMP_PREFIX.exec(line);
  return m ? { ts: m[1]!, rest: m[2]! } : { ts: null, rest: line };
}
