/**
 * Cron evaluated in a named IANA timezone, built on the UTC evaluator in
 * [cron](../backups/cron.ts) rather than beside it.
 *
 * Backups and the docker-cleanup policy are UTC-only and get away with it: "some
 * time overnight" is the whole requirement, and an hour's drift twice a year
 * costs nobody anything. A cron job is somebody's business rule — the nightly
 * invoice run happens at 02:00 *in the company's timezone*, and it still does
 * after the clocks change — so it needs the zone, and needs it per job, because
 * one instance serves teams in different countries.
 *
 * Pure, dependency-free, and NOT `server-only`: the scheduler evaluates these
 * and the job form previews them, and the two must never disagree about when a
 * schedule fires. The only machinery is `Intl.DateTimeFormat`, which every
 * runtime deplo targets already carries with the full zone database.
 *
 * The interesting half is {@link dedupeKeyFor}. DST breaks the two kinds of
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
      // "24" of the previous day, so `0 0 * * *` would never match — silently,
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
 * clock. A "fake UTC" instant — never a real one — which is what lets the UTC
 * evaluator answer a zoned question unchanged, day-of-week included (it falls
 * out of `Date.UTC` arithmetically, so no locale weekday string is ever parsed).
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
 *
 * Two passes: the first guess uses the offset near `wall` treated as an instant,
 * which is always within a day of correct; the second re-reads the offset AT the
 * guess, which is what fixes a candidate sitting on the far side of a DST edge.
 *
 * A wall time that does not exist (the hour spring-forward skips) has no answer;
 * callers detect that by round-tripping, which is what {@link nextCronRunInZone}
 * does.
 */
function zonedToUtc(wall: Date, tz: string): Date {
  const first = new Date(wall.getTime() - offsetAt(wall, tz));
  return new Date(wall.getTime() - offsetAt(first, tz));
}

/**
 * Does `expr` fire at this instant, read in `tz`? Minute precision, like the UTC
 * original — and like it, an unparseable expression never matches rather than
 * throwing, so one malformed schedule cannot kill a scheduler tick.
 *
 * An unknown zone DOES throw (`Intl`'s `RangeError`). That is deliberate: the
 * data layer validates the zone on write, so a bad one here means the row was
 * written by something that bypassed the gate, and silently never firing would
 * hide it. The scheduler contains it per job.
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
    // asked for, that wall clock does not exist in this zone on that day — the
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
 * within `limitDays`. What the job form shows as "next run".
 *
 * Two strategies, because neither alone is both correct and affordable:
 *
 *  - **Walk wall-clock times** (the fast path). Jumps by month/day/hour like the
 *    UTC original, so a yearly schedule costs a handful of steps instead of half
 *    a million. It cannot answer near a fall-back edge, though: it steps FORWARD
 *    through wall times, and a repeated hour is the same wall time twice, so it
 *    would skip the second occurrence and report an answer an hour late.
 *  - **Scan real minutes** (only when a DST transition is inside the window).
 *    ~1560 `Intl` reads, a couple of milliseconds, and correct by construction
 *    because it asks the same question the scheduler asks.
 *
 * Detecting which is two offset reads, so the common call pays almost nothing.
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
      const remainingDays = Math.ceil((deadline - cursor.getTime()) / 86_400_000);
      return walkWallClock(expr, cursor, tz, Math.max(1, remainingDays));
    }
    const start = Math.floor(cursor.getTime() / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
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
 *   once a year. That is the safe direction — this branch can never SUPPRESS a
 *   legitimate fire, only allow an extra one. Upgrade: treat a step of n hours
 *   where `24 % n !== 0` as pinned.
 */
export function pinsHour(expr: string): boolean {
  const hour = expr.trim().split(/\s+/)[1] ?? "*";
  return !hour.includes("*") && !hour.includes("/");
}

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * The value that makes a scheduled fire unique, stored on the run and enforced
 * by `UNIQUE(cron_runs.job_id, dedupe_key)`.
 *
 * It branches because DST breaks the two kinds of schedule in opposite ways, and
 * either key alone is wrong for one of them:
 *
 *  - Fall back repeats a wall-clock hour, so `0 3 * * *` matches at two separate
 *    instants. Keyed on the INSTANT it would fire twice; keyed on the WALL CLOCK
 *    it fires once, which is what "every day at 03:00" means.
 *  - That same repeat means 25 real hours elapse, so an every-5-minutes schedule
 *    legitimately has 24 fires inside it. Keyed on the WALL CLOCK it would run 12
 *    times instead of 24; keyed on the INSTANT it runs all 24, which is what
 *    "every 5 minutes" means.
 *
 * Spring forward needs no branch: a wall-clock minute that does not exist is
 * never reached by either key.
 */
export function dedupeKeyFor(expr: string, at: Date, tz: string): string {
  if (!pinsHour(expr)) return at.toISOString().slice(0, 16);
  const p = zoneParts(at, tz);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}T${pad(p.H)}:${pad(p.M)}@${tz}`;
}

/**
 * The zone's canonical spelling, or null when it is not a zone at all.
 *
 * Validated on WRITE and never on read: `Intl` throws on an unknown zone, and a
 * throw inside the scheduler's tick would stop every other job on the instance.
 * Same idiom as `canonicalTimezone` in lib/data/server-maintenance.ts, which
 * validates the host clock's zone.
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
 * Does this zone change its clocks? Two probes six months apart, which is enough
 * for every zone in the database — including the southern hemisphere, where the
 * shift runs the other way.
 *
 * Used for one thing: deciding whether the job form should mention DST at all.
 */
export function zoneHasDst(tz: string, year = new Date().getUTCFullYear()): boolean {
  try {
    const jan = offsetAt(new Date(Date.UTC(year, 0, 15)), tz);
    const jul = offsetAt(new Date(Date.UTC(year, 6, 15)), tz);
    return jan !== jul;
  } catch {
    return false;
  }
}

/**
 * The sentence to show under a schedule that DST could skip, or null.
 *
 * A wall-clock hour that spring forward removes simply never matches, so a job
 * pinned inside it does not run that day (Vixie cron fires it right after the
 * jump; we don't — see ADR-0018 §4). This tells the user before they find out in
 * March.
 *
 * ponytail: flags the 00:00-04:59 window rather than computing the zone's actual
 *   transition, which is where every DST shift on earth happens. Cheap (two
 *   `Intl` reads) and never misses a real case; it can warn on an hour that
 *   happens to be safe in one particular zone. Exact needs a binary search for
 *   the transition instant, for the same one sentence.
 */
export function dstSkipWarning(expr: string, tz: string): string | null {
  if (!pinsHour(expr) || !zoneHasDst(tz)) return null;
  const hour = Number(expr.trim().split(/\s+/)[1]);
  if (!Number.isInteger(hour) || hour > 4) return null;
  return `On the day ${tz} moves its clocks forward, this hour may not exist and the job will not run that day. Pick a later hour to be sure.`;
}
