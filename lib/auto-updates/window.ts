import { nextCronRunInZone, zoneParts } from "../crons/cron-tz";

// https://deplo.build/docs/operations/update#automatic-updates
export const SLOTS = 3;
const HOUR_MS = 3_600_000;

export function slotHours(start: number): number[] {
  return Array.from({ length: SLOTS }, (_, i) => (start + i) % 24);
}

export interface Slot {
  start: Date;
  windowStart: Date;
  last: boolean;
}

/** The slot `now` falls in, or null between windows. */
export function currentSlot(now: Date, start: number, tz: string): Slot | null {
  const p = zoneParts(now, tz);
  const index = slotHours(start).indexOf(p.H);
  if (index < 0) return null;
  const slotStart = new Date(
    Math.floor(now.getTime() / 60_000) * 60_000 - p.M * 60_000,
  );
  return {
    start: slotStart,
    windowStart: new Date(slotStart.getTime() - index * HOUR_MS),
    last: index === SLOTS - 1,
  };
}

/** The first slot that starts after `from`. */
export function nextSlotAt(from: Date, start: number, tz: string): Date | null {
  return nextCronRunInZone(`0 ${slotHours(start).join(",")} * * *`, from, tz);
}

/** "Postpone one night": past the end of the window `from` is in, or of the next one. */
export function windowEndAfter(from: Date, start: number, tz: string): Date {
  const windowStart =
    currentSlot(from, start, tz)?.windowStart ??
    nextCronRunInZone(`0 ${start} * * *`, from, tz) ??
    from;
  return new Date(windowStart.getTime() + SLOTS * HOUR_MS);
}

const pad = (n: number) => String(n).padStart(2, "0");

/** "at 03:00", "tomorrow at 02:00", "on 6 Nov at 02:00", in the window's own timezone. */
export function describeAt(at: Date, now: Date, tz: string): string {
  const p = zoneParts(at, tz);
  const time = `${pad(p.H)}:${pad(p.M)}`;
  const day = (d: { y: number; m: number; d: number }) =>
    Date.UTC(d.y, d.m - 1, d.d);
  const days = Math.round((day(p) - day(zoneParts(now, tz))) / (24 * HOUR_MS));
  if (days <= 0) return `at ${time}`;
  if (days === 1) return `tomorrow at ${time}`;
  return `on ${wallClock(at, tz)}`;
}

/** "6 Nov at 02:00": for text that is read long after it was written. */
export function wallClock(at: Date, tz: string): string {
  const p = zoneParts(at, tz);
  const day = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    day: "numeric",
    month: "short",
  }).format(at);
  return `${day} at ${pad(p.H)}:${pad(p.M)}`;
}
