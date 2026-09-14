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

// Constructing an `Intl.DateTimeFormat` costs orders of magnitude more than reusing one.
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      // LOAD-BEARING: en-US's default hour cycle formats midnight as hour "24" of the previous day, so `0 0 * * *` would never match.
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

// zoneParts reads `at`'s wall clock in `tz`. Throws `RangeError` on an unknown zone.
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

// A Date whose UTC fields ARE `tz`'s wall clock at `at`.
function fakeUtcOf(at: Date, tz: string): Date {
  const p = zoneParts(at, tz);
  return new Date(Date.UTC(p.y, p.m - 1, p.d, p.H, p.M));
}

// How far `tz`'s wall clock runs ahead of UTC at this instant, in ms.
function offsetAt(instant: Date, tz: string): number {
  return fakeUtcOf(instant, tz).getTime() - instant.getTime();
}

// The instant at which `tz`'s wall clock reads `wall` (itself a fake-UTC Date).
function zonedToUtc(wall: Date, tz: string): Date {
  const first = new Date(wall.getTime() - offsetAt(wall, tz));
  return new Date(wall.getTime() - offsetAt(first, tz));
}

// cronMatchesInZone: minute precision, and an unparseable expression never matches rather than throwing, so one bad schedule cannot kill a tick.
export function cronMatchesInZone(expr: string, at: Date, tz: string): boolean {
  return cronMatches(expr, fakeUtcOf(at, tz));
}

const MINUTE_MS = 60_000;
// How far ahead a minute-by-minute scan reaches. One day plus DST's two hours.
const SCAN_WINDOW_MS = 26 * 3_600_000;

// Walk WALL CLOCK times. Exact whenever no DST transition is in the way.
function walkWallClock(
  expr: string,
  from: Date,
  tz: string,
  limitDays: number,
): Date | null {
  let cursor = fakeUtcOf(from, tz);
  // Bounded: an every-minute schedule inside a spring-forward gap rejects up to 60 candidates in a row.
  for (let i = 0; i < 200; i++) {
    const wall = nextCronRun(expr, cursor, limitDays);
    if (!wall) return null;
    const instant = zonedToUtc(wall, tz);
    // A wall clock that does not read back is the hour spring forward removes: skip it.
    if (fakeUtcOf(instant, tz).getTime() === wall.getTime() && instant > from) {
      return instant;
    }
    cursor = new Date(wall.getTime() + MINUTE_MS);
  }
  return null;
}

// nextCronRunInZone: the next instant `expr` fires read in `tz`, or null if there is none within `limitDays`.
export function nextCronRunInZone(
  expr: string,
  from: Date,
  tz: string,
  limitDays = 366,
): Date | null {
  if (!parseCron(expr)) return null;
  const deadline = from.getTime() + limitDays * 86_400_000;
  let cursor = from;
  // Guarded rather than unbounded: each pass clears 26 hours, and no zone has more than a couple of transitions in a week.
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

// pinsHour: does this expression name specific HOURS? The only schedules a repeated (fall-back) hour can double-fire.
// ponytail: a STEPPED hour counts as an interval, so a repeated hour landing on a
//   step fires twice, once a year - the safe direction. Upgrade: treat a step of
//   n hours where `24 % n !== 0` as pinned.
export function pinsHour(expr: string): boolean {
  const hour = expandCronMacro(expr).trim().split(/\s+/)[1] ?? "*";
  return !hour.includes("*") && !hour.includes("/");
}

const pad = (n: number) => String(n).padStart(2, "0");

// dedupeKeyFor: what makes a scheduled fire unique, enforced by `UNIQUE(cron_runs.job_id, dedupe_key)`.
// DST breaks the two kinds of schedule in OPPOSITE directions, so one key shape cannot serve both.
// Spring forward needs no branch: a wall-clock minute that does not exist is never reached by either key.
export function dedupeKeyFor(expr: string, at: Date, tz: string): string {
  if (!pinsHour(expr)) return at.toISOString().slice(0, 16);
  const p = zoneParts(at, tz);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}T${pad(p.H)}:${pad(p.M)}@${tz}`;
}

// canonicalTimeZone: validated on WRITE and never on read - `Intl` throws on an unknown zone, and a throw inside the tick would stop every other job.
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
  // ICU resolves `Asia/Kolkata` to the older alias `Asia/Calcutta`, which is not in the browser's list, so keep the picker's spelling.
  if (resolved.toLowerCase() === raw.toLowerCase()) return resolved;
  return raw.includes("/") ? raw : resolved;
}

// The wall clock `tz` DELETES at its next spring-forward, as fake-UTC instants (`[start, end)`).
// Probed, not guessed: a January/July shortcut calls Africa/Casablanca fixed, and it still deletes an hour off its Ramadan offset.
// ponytail: reports the FIRST spring-forward ahead. A zone with two in the window
//   can hold a second gap this does not name. Upgrade: return the list.
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
    // Bisect to the minute: `lo` is the last minute on the old offset, `lo + 1` the first on the new one.
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

// `hh:mm` of a fake-UTC wall clock.
const wallTime = (at: Date) =>
  `${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}`;

// dstSkipWarning: the sentence to show under a schedule spring forward will skip, or null.
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
