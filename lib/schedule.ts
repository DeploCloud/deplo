import { expandCronMacro, parseCron } from "./backups/cron";

export { nextCronRun, parseCron } from "./backups/cron";

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

type FixedMode = Exclude<
  ScheduleMode,
  "custom" | "daily" | "weekly" | "monthly"
>;

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

export interface ScheduleOption {
  mode: Exclude<ScheduleMode, "custom">;
  label: string;
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

export const WEEKDAY_LABELS: readonly string[] = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

const WEEKDAY_SHORT: readonly string[] = [
  "Sun",
  "Mon",
  "Tue",
  "Wed",
  "Thu",
  "Fri",
  "Sat",
];

export const MAX_MONTH_DAY = 28;

export const DEFAULT_SCHEDULE = "0 3 * * *";

export interface ScheduleParts {
  mode: ScheduleMode;
  hour: number;
  minute: number;
  weekday: number;
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

const normalize = (cron: string) =>
  expandCronMacro(cron).trim().replace(/\s+/g, " ");

function intField(field: string, min: number, max: number): number | null {
  if (!/^\d+$/.test(field)) return null;
  const n = Number(field);
  return n >= min && n <= max ? n : null;
}

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

export function partsFromCron(cron: string): ScheduleParts | null {
  const expr = normalize(cron);
  const fields = expr.split(" ");
  if (fields.length !== 5) return null;

  for (const [mode, fixed] of Object.entries(FIXED_CRON)) {
    if (expr === fixed) return { ...DEFAULT_PARTS, mode: mode as FixedMode };
  }

  const [minuteField, hourField, domField, monthField, dowField] = fields;
  if (monthField !== "*") return null;
  const minute = intField(minuteField, 0, 59);
  const hour = intField(hourField, 0, 23);
  if (minute === null || hour === null) return null;

  if (domField === "*" && dowField === "*")
    return { ...DEFAULT_PARTS, mode: "daily", hour, minute };
  if (domField === "*") {
    const dow = intField(dowField, 0, 7);
    if (dow === null) return null;
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
  return null;
}

const pad = (n: number) => String(n).padStart(2, "0");

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

export function backupTooFrequent(cron: string): boolean {
  const minute = cron.trim().split(/\s+/)[0] ?? "";
  const step = /^\*\/(\d+)$/.exec(minute);
  return (
    minute === "*" ||
    minute.includes("-") ||
    (!!step && Number(step[1]) < 15) ||
    minute.split(",").length > 4
  );
}

export function isValidSchedule(cron: string): boolean {
  return parseCron(cron) !== null;
}

export function invalidScheduleMessage(cron: string): string {
  return (
    `"${cron.trim()}" is not a valid cron expression. Use 5 fields - ` +
    `minute hour day month weekday - e.g. "${DEFAULT_SCHEDULE}" for daily at 03:00 UTC.`
  );
}
