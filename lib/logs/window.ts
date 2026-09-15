export const MINUTES_PER_DAY = 24 * 60;

export interface LogWindow {
  sinceUnix: number;
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

const TIMESTAMP_PREFIX =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\s([\s\S]*)$/;

export function splitTimestamp(line: string): {
  ts: string | null;
  rest: string;
} {
  const m = TIMESTAMP_PREFIX.exec(line);
  return m ? { ts: m[1]!, rest: m[2]! } : { ts: null, rest: line };
}
