/**
 * Schedules the way a person states them — "every day at 03:00" — with cron kept
 * as the *storage* format, not the *input* format.
 *
 * Cron is what the scheduler evaluates (`lib/backups/cron.ts`) and what the
 * database column holds, so nothing here changes the wire format: this module is
 * the two-way translation between a 5-field expression and the handful of shapes
 * a picker can offer. `partsFromCron` recognises an expression the UI can render
 * as controls; `cronFromParts` emits the canonical expression for those controls;
 * `describeCron` says out loud what an expression does. An expression outside
 * that vocabulary (comma lists, ranges, month restrictions) is not an error — it
 * simply falls through to `null`, and the caller keeps showing the raw text.
 *
 * Pure and dependency-free (no `server-only`), because both the client picker and
 * the server-side validation import it.
 */

import { parseCron } from "./backups/cron";

export { nextCronRun, parseCron } from "./backups/cron";

/**
 * The schedule shapes the UI can express as controls. `custom` is the escape
 * hatch — it has no parts, the caller keeps the raw cron string.
 */
export type ScheduleMode =
  | "every-minute"
  | "every-5-minutes"
  | "every-15-minutes"
  | "every-30-minutes"
  | "hourly"
  | "every-2-hours"
  | "every-6-hours"
  | "every-12-hours"
  | "daily"
  | "weekly"
  | "monthly"
  | "custom";

/** A mode with fixed parameters, i.e. one cron string and nothing to configure. */
type FixedMode = Exclude<
  ScheduleMode,
  "custom" | "daily" | "weekly" | "monthly"
>;

/**
 * The canonical expression for every fixed-interval mode. These are the only
 * strings the picker ever produces for those modes, which is what makes
 * `partsFromCron` a plain lookup for them.
 */
const FIXED_CRON: Record<FixedMode, string> = {
  "every-minute": "* * * * *",
  "every-5-minutes": "*/5 * * * *",
  "every-15-minutes": "*/15 * * * *",
  "every-30-minutes": "*/30 * * * *",
  hourly: "0 * * * *",
  "every-2-hours": "0 */2 * * *",
  "every-6-hours": "0 */6 * * *",
  "every-12-hours": "0 */12 * * *",
};

/** One entry per selectable preset, in the order the picker lists them. */
export interface ScheduleOption {
  mode: Exclude<ScheduleMode, "custom">;
  label: string;
  /** Heading the option is listed under. */
  group: "Minutes" | "Hours" | "Days and longer";
}

export const SCHEDULE_OPTIONS: readonly ScheduleOption[] = [
  { mode: "every-minute", label: "Every minute", group: "Minutes" },
  { mode: "every-5-minutes", label: "Every 5 minutes", group: "Minutes" },
  { mode: "every-15-minutes", label: "Every 15 minutes", group: "Minutes" },
  { mode: "every-30-minutes", label: "Every 30 minutes", group: "Minutes" },
  { mode: "hourly", label: "Every hour", group: "Hours" },
  { mode: "every-2-hours", label: "Every 2 hours", group: "Hours" },
  { mode: "every-6-hours", label: "Every 6 hours", group: "Hours" },
  { mode: "every-12-hours", label: "Every 12 hours", group: "Hours" },
  { mode: "daily", label: "Every day", group: "Days and longer" },
  { mode: "weekly", label: "Every week", group: "Days and longer" },
  { mode: "monthly", label: "Every month", group: "Days and longer" },
];

/** Weekday names indexed by cron day-of-week (0 = Sunday). */
export const WEEKDAY_LABELS: readonly string[] = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

/** The same weekdays, abbreviated — for the compact description a table cell wants. */
const WEEKDAY_SHORT: readonly string[] = [
  "Sun",
  "Mon",
  "Tue",
  "Wed",
  "Thu",
  "Fri",
  "Sat",
];

/**
 * Highest day-of-month a monthly schedule may pick. 29–31 are deliberately NOT
 * offered: cron simply skips a month that has no such day, so "every month on
 * the 31st" would silently not run in February — the one failure a scheduled
 * backup cannot have.
 */
export const MAX_MONTH_DAY = 28;

/** The platform-wide default: daily at 03:00 UTC. */
export const DEFAULT_SCHEDULE = "0 3 * * *";

/**
 * A schedule as the picker's controls hold it. The fields a given `mode` doesn't
 * use are still carried so switching modes keeps the time the user already
 * chose.
 */
export interface ScheduleParts {
  mode: ScheduleMode;
  /** Hour of day, UTC (0–23). Used by daily / weekly / monthly. */
  hour: number;
  /** Minute past the hour (0–59). Used by daily / weekly / monthly. */
  minute: number;
  /** Cron day-of-week, 0 = Sunday. Used by weekly. */
  weekday: number;
  /** Day of month, 1–{@link MAX_MONTH_DAY}. Used by monthly. */
  day: number;
}

export const DEFAULT_PARTS: ScheduleParts = {
  mode: "daily",
  hour: 3,
  minute: 0,
  weekday: 0,
  day: 1,
};

const clamp = (n: number, lo: number, hi: number) =>
  Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.trunc(n))) : lo;

/** Collapse runs of whitespace so a hand-typed expression compares by value. */
const normalize = (cron: string) => cron.trim().replace(/\s+/g, " ");

/** A field that is a bare integer inside `[min, max]`, else null. */
function intField(field: string, min: number, max: number): number | null {
  if (!/^\d+$/.test(field)) return null;
  const n = Number(field);
  return n >= min && n <= max ? n : null;
}

/** The cron expression for these parts. `custom` has none — callers keep their raw text. */
export function cronFromParts(parts: ScheduleParts): string {
  const minute = clamp(parts.minute, 0, 59);
  const hour = clamp(parts.hour, 0, 23);
  switch (parts.mode) {
    case "daily":
      return `${minute} ${hour} * * *`;
    case "weekly":
      return `${minute} ${hour} * * ${clamp(parts.weekday, 0, 6)}`;
    case "monthly":
      return `${minute} ${hour} ${clamp(parts.day, 1, MAX_MONTH_DAY)} * *`;
    case "custom":
      return DEFAULT_SCHEDULE;
    default:
      return FIXED_CRON[parts.mode];
  }
}

/**
 * Read an expression back into controls, or null when it says something the
 * controls can't (a comma list, a range, a specific month, day 29+). Null is the
 * signal to fall back to the raw-cron escape hatch — never an error.
 */
export function partsFromCron(cron: string): ScheduleParts | null {
  const expr = normalize(cron);
  const fields = expr.split(" ");
  if (fields.length !== 5) return null;

  for (const [mode, fixed] of Object.entries(FIXED_CRON)) {
    if (expr === fixed) return { ...DEFAULT_PARTS, mode: mode as FixedMode };
  }

  const [minuteField, hourField, domField, monthField, dowField] = fields;
  // A month restriction ("only in June") has no control, so it stays custom.
  if (monthField !== "*") return null;
  const minute = intField(minuteField, 0, 59);
  const hour = intField(hourField, 0, 23);
  if (minute === null || hour === null) return null;

  if (domField === "*" && dowField === "*")
    return { ...DEFAULT_PARTS, mode: "daily", hour, minute };
  if (domField === "*") {
    const dow = intField(dowField, 0, 7);
    if (dow === null) return null;
    // Cron accepts both 0 and 7 for Sunday; the control only knows 0.
    return {
      ...DEFAULT_PARTS,
      mode: "weekly",
      hour,
      minute,
      weekday: dow === 7 ? 0 : dow,
    };
  }
  if (dowField === "*") {
    const day = intField(domField, 1, MAX_MONTH_DAY);
    if (day === null) return null;
    return { ...DEFAULT_PARTS, mode: "monthly", hour, minute, day };
  }
  // Both day fields restricted — the Vixie union rule, which no control models.
  return null;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** "1st", "2nd", "3rd", "4th"… for a day of the month. */
function ordinal(day: number): string {
  const rest = day % 100;
  if (rest >= 11 && rest <= 13) return `${day}th`;
  switch (day % 10) {
    case 1:
      return `${day}st`;
    case 2:
      return `${day}nd`;
    case 3:
      return `${day}rd`;
    default:
      return `${day}th`;
  }
}

const FIXED_LABELS = new Map(SCHEDULE_OPTIONS.map((o) => [o.mode, o.label]));

/**
 * Say what an expression does in one phrase — "Every week on Sunday at 03:00
 * UTC" — or null when it isn't one of the shapes the picker knows. Null means
 * "show the raw cron instead", not "invalid": validity is `isValidSchedule`.
 *
 * `compact` trades the sentence for a table cell's worth of room ("Weekly, Wed
 * 03:00 UTC") — same facts, no filler words.
 *
 * `timeZone` names the zone the expression is read in. It defaults to UTC, which
 * is what backups and docker cleanup are evaluated in; a cron job carries its own
 * zone, and saying "03:00 UTC" for a schedule that fires at 03:00 in Rome would
 * be a plain lie.
 */
export function describeCron(
  cron: string,
  opts?: { compact?: boolean; timeZone?: string },
): string | null {
  const parts = partsFromCron(cron);
  if (!parts) return null;
  const at = `${pad(parts.hour)}:${pad(parts.minute)} ${opts?.timeZone ?? "UTC"}`;
  const compact = opts?.compact === true;
  switch (parts.mode) {
    case "daily":
      return compact ? `Daily, ${at}` : `Every day at ${at}`;
    case "weekly":
      return compact
        ? `Weekly, ${WEEKDAY_SHORT[parts.weekday]} ${at}`
        : `Every week on ${WEEKDAY_LABELS[parts.weekday]} at ${at}`;
    case "monthly":
      return compact
        ? `Monthly, ${ordinal(parts.day)} ${at}`
        : `Every month on the ${ordinal(parts.day)} at ${at}`;
    case "custom":
      return null;
    default:
      return FIXED_LABELS.get(parts.mode) ?? null;
  }
}

/**
 * Would the scheduler ever fire this expression? An unparseable cron is treated
 * as "never matches" by design (one bad row must not crash the tick), so an
 * accepted-but-unparseable schedule is a job that silently never runs while the
 * UI claims it is enabled — hence both the picker and the data layer reject it up
 * front.
 */
export function isValidSchedule(cron: string): boolean {
  return parseCron(cron) !== null;
}

/** The message shown when {@link isValidSchedule} says no — shared by UI and API. */
export function invalidScheduleMessage(cron: string): string {
  return (
    `"${cron.trim()}" is not a valid cron expression. Use 5 fields — ` +
    `minute hour day month weekday — e.g. "${DEFAULT_SCHEDULE}" for daily at 03:00 UTC.`
  );
}
