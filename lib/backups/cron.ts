const BOUNDS: ReadonlyArray<readonly [number, number]> = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
];

const MACROS: Record<string, string> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};

const MONTH_NAMES = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
];
const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

export function expandCronMacro(expr: string): string {
  return MACROS[expr.trim().toLowerCase()] ?? expr;
}

function nameToNumber(
  token: string,
  names: readonly string[],
  base: number,
): string {
  const i = names.indexOf(token.toLowerCase());
  return i === -1 ? token : String(i + base);
}

function parseField(
  field: string,
  min: number,
  max: number,
  names?: readonly string[],
): Set<number> | null {
  const out = new Set<number>();
  const num = (t: string) => (names ? nameToNumber(t, names, min) : t);
  for (const part of field.split(",")) {
    if (part.length === 0) return null;
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
      lo = Number(num(a));
      hi = Number(num(b));
      if (!Number.isInteger(lo) || !Number.isInteger(hi)) return null;
    } else {
      const n = Number(num(rangePart));
      if (!Number.isInteger(n)) return null;
      lo = n;
      hi = stepPart !== undefined ? max : n;
    }
    if (lo < min || hi > max || lo > hi) return null;
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out.size > 0 ? out : null;
}

interface ParsedCron {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  domAny: boolean;
  dowAny: boolean;
}

export function parseCron(expr: string): ParsedCron | null {
  const fields = expandCronMacro(expr).trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const sets = fields.map((f, i) =>
    parseField(
      f,
      BOUNDS[i][0],
      BOUNDS[i][1],
      i === 3 ? MONTH_NAMES : i === 4 ? DAY_NAMES : undefined,
    ),
  );
  if (sets.some((s) => s === null)) return null;
  const [minute, hour, dom, month, dow] = sets as Set<number>[];
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

function dayMatches(c: ParsedCron, at: Date): boolean {
  const domMatch = c.dom.has(at.getUTCDate());
  const dowMatch = c.dow.has(at.getUTCDay());
  if (c.domAny && c.dowAny) return true;
  if (c.domAny) return dowMatch;
  if (c.dowAny) return domMatch;
  return domMatch || dowMatch;
}

export function cronMatches(expr: string, at: Date): boolean {
  const c = parseCron(expr);
  if (!c) return false;
  if (!c.minute.has(at.getUTCMinutes())) return false;
  if (!c.hour.has(at.getUTCHours())) return false;
  if (!c.month.has(at.getUTCMonth() + 1)) return false;
  return dayMatches(c, at);
}

export function nextCronRun(
  expr: string,
  from: Date,
  limitDays = 366,
): Date | null {
  const c = parseCron(expr);
  if (!c) return null;
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
