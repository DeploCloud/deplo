// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A tiny standard 5-field cron evaluator - `minute hour day-of-month month
 * day-of-week`. An unparseable expression is treated as "never matches" rather
 * than throwing, so one malformed schedule can't crash the scheduler tick.
 */

/** Each field's inclusive [min, max] bound. */
const BOUNDS: ReadonlyArray<readonly [number, number]> = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day of month
  [1, 12], // month
  [0, 7], // day of week (0 and 7 both = Sunday)
];

/**
 * Parse one cron field into the explicit set of integers it allows within
 * `[min, max]`. Returns null when the field is malformed (the caller treats a
 * null field as an unparseable expression). `*` yields the full range.
 */
function parseField(
  field: string,
  min: number,
  max: number,
): Set<number> | null {
  const out = new Set<number>();
  for (const part of field.split(",")) {
    if (part.length === 0) return null;
    // Split an optional `/step` suffix off the range/wildcard base.
    const [rangePart, stepPart, ...rest] = part.split("/");
    if (rest.length > 0) return null;
    let step = 1;
    if (stepPart !== undefined) {
      step = Number(stepPart);
      if (!Number.isInteger(step) || step <= 0) return null;
    }

    let lo: number;
    let hi: number;
    if (rangePart === "*") {
      lo = min;
      hi = max;
    } else if (rangePart.includes("-")) {
      const [a, b, ...more] = rangePart.split("-");
      if (more.length > 0) return null;
      lo = Number(a);
      hi = Number(b);
      if (!Number.isInteger(lo) || !Number.isInteger(hi)) return null;
    } else {
      const n = Number(rangePart);
      if (!Number.isInteger(n)) return null;
      lo = n;
      hi = n;
    }
    if (lo < min || hi > max || lo > hi) return null;
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out.size > 0 ? out : null;
}

/** A parsed cron expression: one allowed-value set per field. */
interface ParsedCron {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  /** True when day-of-month was given as `*` (drives the DOM/DOW union rule). */
  domAny: boolean;
  /** True when day-of-week was given as `*`. */
  dowAny: boolean;
}

/**
 * Parse a 5-field cron string. Returns null if it does not have exactly five
 * fields or any field is malformed - the scheduler treats null as "never".
 */
export function parseCron(expr: string): ParsedCron | null {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const sets = fields.map((f, i) => parseField(f, BOUNDS[i][0], BOUNDS[i][1]));
  if (sets.some((s) => s === null)) return null;
  const [minute, hour, dom, month, dow] = sets as Set<number>[];
  // Normalise day-of-week 7 → 0 so a `Date.getUTCDay()` (0..6) lookup is direct.
  if (dow.delete(7)) dow.add(0);
  return {
    minute,
    hour,
    dom,
    month,
    dow,
    domAny: fields[2] === "*",
    dowAny: fields[4] === "*",
  };
}

/**
 * Does the DAY of `at` satisfy the parsed expression? Split out of
 * {@link cronMatches} because {@link nextCronRun} needs the same Vixie
 * day-of-month / day-of-week union rule while skipping whole days at a time.
 */
function dayMatches(c: ParsedCron, at: Date): boolean {
  const domMatch = c.dom.has(at.getUTCDate());
  const dowMatch = c.dow.has(at.getUTCDay());
  // Vixie rule: if both day fields are restricted, the day matches when EITHER
  // does (union). If one is `*`, only the other constrains.
  if (c.domAny && c.dowAny) return true;
  if (c.domAny) return dowMatch;
  if (c.dowAny) return domMatch;
  return domMatch || dowMatch;
}

/**
 * Does `expr` fire at the given instant? Evaluated to MINUTE precision in UTC
 * (the scheduler ticks once a minute and the store stamps ISO/UTC), so seconds
 * are ignored. An unparseable expression never matches.
 */
export function cronMatches(expr: string, at: Date): boolean {
  const c = parseCron(expr);
  if (!c) return false;
  if (!c.minute.has(at.getUTCMinutes())) return false;
  if (!c.hour.has(at.getUTCHours())) return false;
  if (!c.month.has(at.getUTCMonth() + 1)) return false;
  return dayMatches(c, at);
}

/**
 * The first instant strictly AFTER `from` at which `expr` fires, or null when it
 * is unparseable or fires nowhere inside `limitDays` (e.g. `0 0 30 2 *` - the 30th
 * of February).
 */
export function nextCronRun(
  expr: string,
  from: Date,
  limitDays = 366,
): Date | null {
  const c = parseCron(expr);
  if (!c) return null;
  // Start at the next whole minute: "next" is strictly after `from`, and a cron
  // fires at second 0.
  const cursor = new Date(
    Date.UTC(
      from.getUTCFullYear(),
      from.getUTCMonth(),
      from.getUTCDate(),
      from.getUTCHours(),
      from.getUTCMinutes(),
    ) + 60_000,
  );
  const deadline = cursor.getTime() + limitDays * 86_400_000;

  while (cursor.getTime() <= deadline) {
    if (!c.month.has(cursor.getUTCMonth() + 1)) {
      // Jump to 00:00 on the 1st of the next month.
      cursor.setUTCMonth(cursor.getUTCMonth() + 1, 1);
      cursor.setUTCHours(0, 0, 0, 0);
      continue;
    }
    if (!dayMatches(c, cursor)) {
      cursor.setUTCDate(cursor.getUTCDate() + 1);
      cursor.setUTCHours(0, 0, 0, 0);
      continue;
    }
    if (!c.hour.has(cursor.getUTCHours())) {
      // Rolls the date over on its own when the hour is 23.
      cursor.setUTCHours(cursor.getUTCHours() + 1, 0, 0, 0);
      continue;
    }
    if (!c.minute.has(cursor.getUTCMinutes())) {
      cursor.setUTCMinutes(cursor.getUTCMinutes() + 1, 0, 0);
      continue;
    }
    return new Date(cursor);
  }
  return null;
}
