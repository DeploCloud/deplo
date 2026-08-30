// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Cron evaluated in a named IANA timezone, built on the UTC evaluator in
 * [cron](../backups/cron.ts) rather than beside it. DST breaks the two kinds of
 * schedule in OPPOSITE directions, so one dedupe key cannot serve both.
 */

import { cronMatches, nextCronRun, parseCron } from "../backups/cron";

/** Wall-clock fields of an instant, as read in some zone. */
interface ZoneParts {
  y: number;
  m: number;
  d: number;
  H: number;
  M: number;
}

/**
 * One formatter per zone, kept for the process's life. A scheduler tick formats
 * once per enabled job per replayed minute, and constructing an
 * `Intl.DateTimeFormat` is orders of magnitude more expensive than using one.
 */
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      // LOAD-BEARING. The default hour cycle for en-US formats midnight as hour
      // "24" of the previous day, so `0 0 * * *` would never match - silently,
      // once a day, in every zone. `h23` is the only correct setting here.
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

/** Read `at`'s wall clock in `tz`. Throws `RangeError` on an unknown zone. */
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

/**
 * `at`'s wall clock in `tz`, packed into a Date whose UTC fields ARE that wall
 * clock.
 */
function fakeUtcOf(at: Date, tz: string): Date {
  const p = zoneParts(at, tz);
  return new Date(Date.UTC(p.y, p.m - 1, p.d, p.H, p.M));
}

/** How far `tz`'s wall clock runs ahead of UTC at this instant, in ms. */
function offsetAt(instant: Date, tz: string): number {
  return fakeUtcOf(instant, tz).getTime() - instant.getTime();
}

/**
 * The instant at which `tz`'s wall clock reads `wall` (itself a fake-UTC Date).
 */
function zonedToUtc(wall: Date, tz: string): Date {
  const first = new Date(wall.getTime() - offsetAt(wall, tz));
  return new Date(wall.getTime() - offsetAt(first, tz));
}

/**
 * Does `expr` fire at this instant, read in `tz`? Minute precision, like the UTC
 * original - and like it, an unparseable expression never matches rather than
 * throwing, so one malformed schedule cannot kill a scheduler tick.
 */
export function cronMatchesInZone(expr: string, at: Date, tz: string): boolean {
  return cronMatches(expr, fakeUtcOf(at, tz));
}

const MINUTE_MS = 60_000;
/** How far ahead a minute-by-minute scan reaches. One day plus DST's two hours. */
const SCAN_WINDOW_MS = 26 * 3_600_000;

/** Walk WALL CLOCK times. Exact whenever no DST transition is in the way. */
function walkWallClock(
  expr: string,
  from: Date,
  tz: string,
  limitDays: number,
): Date | null {
  let cursor = fakeUtcOf(from, tz);
  // Bounded rather than `while (true)`: an every-minute schedule inside a
  // spring-forward gap rejects up to 60 candidates in a row, and a zone with a
  // pathological rule must still terminate.
  for (let i = 0; i < 200; i++) {
    const wall = nextCronRun(expr, cursor, limitDays);
    if (!wall) return null;
    const instant = zonedToUtc(wall, tz);
    // Round-trip: if reading the instant back does not give the wall clock we
    // asked for, that wall clock does not exist in this zone on that day - the
    // hour spring forward removes. Skip past it and keep looking.
    if (fakeUtcOf(instant, tz).getTime() === wall.getTime() && instant > from) {
      return instant;
    }
    cursor = new Date(wall.getTime() + MINUTE_MS);
  }
  return null;
}

/**
 * The next instant at which `expr` fires, read in `tz`, or null if there is none
 * within `limitDays`. Two strategies, because neither alone is both correct and
 * affordable: - **Walk wall-clock times** (the fast path).
 */
export function nextCronRunInZone(
  expr: string,
  from: Date,
  tz: string,
  limitDays = 366,
): Date | null {
  if (!parseCron(expr)) return null;
  const deadline = from.getTime() + limitDays * 86_400_000;
  let cursor = from;
  // Guarded rather than unbounded: each pass clears 26 hours, and no zone has
  // more than a couple of transitions in a week.
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

/**
 * Does this expression name specific HOURS? The only schedules a repeated
 * (fall-back) hour can double-fire.
 *
 * ponytail: a STEPPED hour ("every 6 hours") counts as an interval here, so if a
 *   zone's repeated hour happens to land on one of its steps the job fires twice,
 *   once a year. That is the safe direction - this branch can never SUPPRESS a
 *   legitimate fire, only allow an extra one. Upgrade: treat a step of n hours
 *   where `24 % n !== 0` as pinned.
 */
export function pinsHour(expr: string): boolean {
  const hour = expr.trim().split(/\s+/)[1] ?? "*";
  return !hour.includes("*") && !hour.includes("/");
}

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * The value that makes a scheduled fire unique, stored on the run and enforced by
 * `UNIQUE(cron_runs.job_id, dedupe_key)`. Spring forward needs no branch: a
 * wall-clock minute that does not exist is never reached by either key.
 */
export function dedupeKeyFor(expr: string, at: Date, tz: string): string {
  if (!pinsHour(expr)) return at.toISOString().slice(0, 16);
  const p = zoneParts(at, tz);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}T${pad(p.H)}:${pad(p.M)}@${tz}`;
}

/**
 * The zone's canonical spelling, or null when it is not a zone at all. Validated
 * on WRITE and never on read: `Intl` throws on an unknown zone, and a throw inside
 * the scheduler's tick would stop every other job on the instance.
 */
export function canonicalTimeZone(tz: string): string | null {
  const raw = tz.trim();
  if (!raw) return null;
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: raw }).resolvedOptions()
      .timeZone;
  } catch {
    return null;
  }
}

/**
 * The wall clock `tz` DELETES at its next spring-forward, as fake-UTC instants
 * (`[start, end)`, so `start` is the first minute that never happens). Null for a
 * zone that has no such jump in the next 13 months.
 *
 * Found rather than guessed: monthly probes for the pair of months whose offsets
 * differ upward, then a binary search over minutes for the exact transition. ~30
 * `Intl` reads on a zone that moves, 14 on one that doesn't.
 *
 * The scan is the ONLY test - a "does this zone use DST?" shortcut comparing
 * January to July is wrong for Africa/Casablanca, which is UTC+1 in both and
 * still deletes an hour when it comes back off its Ramadan offset.
 *
 * ponytail: reports the FIRST spring-forward ahead, which is the one a schedule
 *   meets first. A zone with two of them in the window (Africa/Casablanca pauses
 *   DST for Ramadan) can hold a second gap this does not name. Upgrade: return
 *   the list and warn on each.
 */
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
    // Bisect to the minute: `lo` is the last minute on the old offset, `lo + 1`
    // the first on the new one.
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

/** `hh:mm` of a fake-UTC wall clock. */
const wallTime = (at: Date) =>
  `${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}`;

/**
 * The sentence to show under a schedule spring forward will skip, or null.
 */
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
