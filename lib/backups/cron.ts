/**
 * A tiny standard 5-field cron evaluator — `minute hour day-of-month month
 * day-of-week`. Just enough for the backup scheduler (Step 6): it answers one
 * question — "is this cron due at this minute?" — so it needs `matches(expr,
 * date)`, not a next-run iterator. Kept dependency-free and pure (no clock of its
 * own) so it unit-tests against fixed `Date`s.
 *
 * Supported per field: `*`, a single number, comma lists (`1,15`), ranges
 * (`1-5`), steps on a range or wildcard (`*​/15`, `0-30/10`), and the usual
 * convenience that day-of-week `7` == `0` (Sunday). Names (`MON`, `JAN`) are NOT
 * supported — Deplo emits numeric crons everywhere (the UI default is
 * `0 3 * * *`). An unparseable expression is treated as "never matches" rather
 * than throwing, so one malformed schedule can't crash the scheduler tick.
 *
 * Day-of-month / day-of-week semantics follow Vixie cron: when BOTH are
 * restricted (neither is `*`), the match is their UNION (either one matching
 * fires); when one is `*`, only the other constrains. This matches what operators
 * expect from `0 0 13 * 5` ("the 13th OR any Friday").
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
function parseField(field: string, min: number, max: number): Set<number> | null {
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
 * fields or any field is malformed — the scheduler treats null as "never".
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

  const domMatch = c.dom.has(at.getUTCDate());
  const dowMatch = c.dow.has(at.getUTCDay());
  // Vixie rule: if both day fields are restricted, the day matches when EITHER
  // does (union). If one is `*`, only the other constrains.
  if (c.domAny && c.dowAny) return true;
  if (c.domAny) return dowMatch;
  if (c.dowAny) return domMatch;
  return domMatch || dowMatch;
}
