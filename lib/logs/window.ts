/**
 * The time window a log stream is opened with, parsed off the SSE request.
 */

export const MINUTES_PER_DAY = 24 * 60;

export interface LogWindow {
  /** Unix SECONDS, or 0 for "no lower bound" - the agent's own "unset". */
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
 * `docker logs --timestamps` prefixes every line with an RFC3339Nano instant and a
 * single space: 2026-08-24T16:23:39.267596474Z {"level":"info","msg":"listening on
 * :3000"} Split it back off.
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
