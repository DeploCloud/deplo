import {
  cronMatches,
  expandCronMacro,
  nextCronRun,
  parseCron,
} from "../backups/cron";

interface ZoneParts {
  y: number;
  m: number;
  d: number;
  H: number;
  M: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      // Load-bearing: en-US's default cycle formats midnight as hour 24, so "0 0 * * *" would never match.
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    formatters.set(tz, f);
  }
  return f;
}

export function zoneParts(at: Date, tz: string): ZoneParts {
  const parts = formatterFor(tz).formatToParts(at);
  const get = (type: string): number => {
    const found = parts.find((p) => p.type === type);
    return found ? Number(found.value) : 0;
  };
  return {
    y: get("year"),
    m: get("month"),
    d: get("day"),
    H: get("hour"),
    M: get("minute"),
  };
}

function fakeUtcOf(at: Date, tz: string): Date {
  const p = zoneParts(at, tz);
  return new Date(Date.UTC(p.y, p.m - 1, p.d, p.H, p.M));
}

function offsetAt(instant: Date, tz: string): number {
  return fakeUtcOf(instant, tz).getTime() - instant.getTime();
}

function zonedToUtc(wall: Date, tz: string): Date {
  const first = new Date(wall.getTime() - offsetAt(wall, tz));
  return new Date(wall.getTime() - offsetAt(first, tz));
}

export function cronMatchesInZone(expr: string, at: Date, tz: string): boolean {
  return cronMatches(expr, fakeUtcOf(at, tz));
}

const MINUTE_MS = 60_000;
const SCAN_WINDOW_MS = 26 * 3_600_000;

function walkWallClock(
  expr: string,
  from: Date,
  tz: string,
  limitDays: number,
): Date | null {
  let cursor = fakeUtcOf(from, tz);
  for (let i = 0; i < 200; i++) {
    const wall = nextCronRun(expr, cursor, limitDays);
    if (!wall) return null;
    const instant = zonedToUtc(wall, tz);
    if (fakeUtcOf(instant, tz).getTime() === wall.getTime() && instant > from) {
      return instant;
    }
    cursor = new Date(wall.getTime() + MINUTE_MS);
  }
  return null;
}

export function nextCronRunInZone(
  expr: string,
  from: Date,
  tz: string,
  limitDays = 366,
): Date | null {
  if (!parseCron(expr)) return null;
  const deadline = from.getTime() + limitDays * 86_400_000;
  let cursor = from;
  for (let pass = 0; pass < 8 && cursor.getTime() < deadline; pass++) {
    const horizonMs = Math.min(cursor.getTime() + SCAN_WINDOW_MS, deadline);
    const horizon = new Date(horizonMs);
    if (offsetAt(cursor, tz) === offsetAt(horizon, tz)) {
      const remainingDays = Math.ceil(
        (deadline - cursor.getTime()) / 86_400_000,
      );
      return walkWallClock(expr, cursor, tz, Math.max(1, remainingDays));
    }
    const start =
      Math.floor(cursor.getTime() / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
    for (let t = start; t <= horizonMs; t += MINUTE_MS) {
      const at = new Date(t);
      if (cronMatchesInZone(expr, at, tz)) return at;
    }
    cursor = horizon;
  }
  return null;
}

// ponytail: a STEPPED hour counts as an interval, so a repeated hour landing on a
export function pinsHour(expr: string): boolean {
  const hour = expandCronMacro(expr).trim().split(/\s+/)[1] ?? "*";
  return !hour.includes("*") && !hour.includes("/");
}

const pad = (n: number) => String(n).padStart(2, "0");

// Two key shapes: DST breaks pinned-hour and interval schedules in opposite directions (ADR-0018).
export function dedupeKeyFor(expr: string, at: Date, tz: string): string {
  if (!pinsHour(expr)) return at.toISOString().slice(0, 16);
  const p = zoneParts(at, tz);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}T${pad(p.H)}:${pad(p.M)}@${tz}`;
}

export function canonicalTimeZone(tz: string): string | null {
  const raw = tz.trim();
  if (!raw) return null;
  let resolved: string;
  try {
    resolved = new Intl.DateTimeFormat("en-US", {
      timeZone: raw,
    }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
  if (resolved.toLowerCase() === raw.toLowerCase()) return resolved;
  return raw.includes("/") ? raw : resolved;
}

// ponytail: reports the FIRST spring-forward ahead. A zone with two in the window
function springForwardGap(
  tz: string,
  from: Date,
): { start: Date; end: Date } | null {
  const probes = [from];
  for (let i = 1; i <= 13; i++) {
    probes.push(
      new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + i, 1)),
    );
  }
  for (let i = 0; i < probes.length - 1; i++) {
    const before = offsetAt(probes[i], tz);
    if (offsetAt(probes[i + 1], tz) <= before) continue;
    let lo = Math.floor(probes[i].getTime() / MINUTE_MS);
    let hi = Math.ceil(probes[i + 1].getTime() / MINUTE_MS);
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      if (offsetAt(new Date(mid * MINUTE_MS), tz) === before) lo = mid;
      else hi = mid;
    }
    return {
      start: new Date(
        fakeUtcOf(new Date(lo * MINUTE_MS), tz).getTime() + MINUTE_MS,
      ),
      end: fakeUtcOf(new Date(hi * MINUTE_MS), tz),
    };
  }
  return null;
}

const wallDay = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  day: "numeric",
  month: "long",
  year: "numeric",
});

const wallTime = (at: Date) =>
  `${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}`;

export function dstSkipWarning(
  expr: string,
  tz: string,
  from: Date = new Date(),
): string | null {
  if (!pinsHour(expr)) return null;
  const gap = springForwardGap(tz, from);
  if (!gap) return null;
  for (let t = gap.start.getTime(); t < gap.end.getTime(); t += MINUTE_MS) {
    if (!cronMatches(expr, new Date(t))) continue;
    return `${tz} skips ${wallTime(gap.start)} to ${wallTime(gap.end)} on ${wallDay.format(gap.start)}, so nothing runs at this time that day.`;
  }
  return null;
}
