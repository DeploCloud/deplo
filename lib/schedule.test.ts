import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_SCHEDULE,
  MAX_MONTH_DAY,
  SCHEDULE_OPTIONS,
  cronFromParts,
  describeCron,
  isValidSchedule,
  partsFromCron,
  type ScheduleParts,
} from "./schedule";

/**
 * The picker's contract with the scheduler: whatever a person chooses in the UI
 * must come back out as a cron the matcher understands, and whatever is already
 * stored must come back INTO the controls unchanged.
 */

const parts = (over: Partial<ScheduleParts>): ScheduleParts => ({
  mode: "daily",
  hour: 3,
  minute: 0,
  weekday: 0,
  day: 1,
  ...over,
});

test("every offered preset produces a cron the matcher can parse", () => {
  for (const option of SCHEDULE_OPTIONS) {
    const cron = cronFromParts(parts({ mode: option.mode }));
    assert.ok(
      isValidSchedule(cron),
      `${option.mode} produced an unparseable expression: ${cron}`,
    );
  }
});

test("every offered preset round-trips back into the same controls", () => {
  for (const option of SCHEDULE_OPTIONS) {
    const cron = cronFromParts(parts({ mode: option.mode }));
    const back = partsFromCron(cron);
    assert.ok(back, `${option.mode} (${cron}) did not read back as a preset`);
    assert.equal(back.mode, option.mode);
    // Re-emitting from the parsed controls must give byte-identical cron.
    assert.equal(cronFromParts(back), cron);
  }
});

test("the fixed intervals emit the canonical expressions", () => {
  assert.equal(cronFromParts(parts({ mode: "every-minute" })), "* * * * *");
  assert.equal(
    cronFromParts(parts({ mode: "every-5-minutes" })),
    "*/5 * * * *",
  );
  assert.equal(
    cronFromParts(parts({ mode: "every-15-minutes" })),
    "*/15 * * * *",
  );
  assert.equal(
    cronFromParts(parts({ mode: "every-30-minutes" })),
    "*/30 * * * *",
  );
  assert.equal(cronFromParts(parts({ mode: "hourly" })), "0 * * * *");
  assert.equal(cronFromParts(parts({ mode: "every-2-hours" })), "0 */2 * * *");
  assert.equal(cronFromParts(parts({ mode: "every-6-hours" })), "0 */6 * * *");
  assert.equal(
    cronFromParts(parts({ mode: "every-12-hours" })),
    "0 */12 * * *",
  );
});

test("daily / weekly / monthly carry the chosen time into the expression", () => {
  assert.equal(
    cronFromParts(parts({ mode: "daily", hour: 3, minute: 0 })),
    "0 3 * * *",
  );
  assert.equal(
    cronFromParts(parts({ mode: "daily", hour: 17, minute: 45 })),
    "45 17 * * *",
  );
  assert.equal(
    cronFromParts(parts({ mode: "weekly", weekday: 5, hour: 9, minute: 30 })),
    "30 9 * * 5",
  );
  assert.equal(
    cronFromParts(parts({ mode: "monthly", day: 12, hour: 4, minute: 15 })),
    "15 4 12 * *",
  );
});

test("the daily default is what the platform default says it is", () => {
  assert.equal(cronFromParts(parts({ mode: "daily" })), DEFAULT_SCHEDULE);
  assert.equal(partsFromCron(DEFAULT_SCHEDULE)?.mode, "daily");
});

test("out-of-range parts are clamped, never emitted as a broken cron", () => {
  const cron = cronFromParts(
    parts({ mode: "monthly", day: 99, hour: 99, minute: -3 }),
  );
  assert.equal(cron, `0 23 ${MAX_MONTH_DAY} * *`);
  assert.ok(isValidSchedule(cron));
});

test("a stored expression reads back into the controls that made it", () => {
  const weekly = partsFromCron("30 9 * * 5");
  assert.deepEqual(weekly, {
    mode: "weekly",
    hour: 9,
    minute: 30,
    weekday: 5,
    day: 1,
  });

  const monthly = partsFromCron("15 4 12 * *");
  assert.deepEqual(monthly, {
    mode: "monthly",
    hour: 4,
    minute: 15,
    weekday: 0,
    day: 12,
  });
});

test("day-of-week 7 reads back as Sunday (cron accepts both, the control knows 0)", () => {
  assert.equal(partsFromCron("0 12 * * 7")?.weekday, 0);
  assert.equal(partsFromCron("0 12 * * 0")?.weekday, 0);
});

test("extra whitespace still matches a preset", () => {
  assert.equal(partsFromCron("  0   3   *   *   *  ")?.mode, "daily");
  assert.equal(partsFromCron(" */15  *  *  *  * ")?.mode, "every-15-minutes");
});

test("expressions outside the picker's vocabulary stay custom, not broken", () => {
  // Each of these is a perfectly valid cron the controls simply can't express.
  for (const cron of [
    "0,30 * * * *", // comma list
    "0 1-5 * * *", // range
    "0 0 1 6 *", // one specific month
    "0 0 13 * 5", // both day fields restricted (Vixie union)
    "0 0 31 * *", // day 31 - deliberately not offered
    "0-30/10 * * * *", // stepped range
  ]) {
    assert.equal(partsFromCron(cron), null, `${cron} should be custom`);
    assert.equal(describeCron(cron), null, `${cron} should have no phrase`);
    // Custom does NOT mean invalid - the scheduler still runs these.
    assert.ok(isValidSchedule(cron), `${cron} should still be a valid cron`);
  }
});

test("describeCron says what the schedule does", () => {
  assert.equal(describeCron("* * * * *"), "Every minute");
  assert.equal(describeCron("*/15 * * * *"), "Every 15 minutes");
  assert.equal(describeCron("0 */6 * * *"), "Every 6 hours");
  assert.equal(describeCron("0 3 * * *"), "Every day at 03:00 UTC");
  assert.equal(describeCron("30 9 * * 5"), "Every week on Friday at 09:30 UTC");
  assert.equal(
    describeCron("15 4 12 * *"),
    "Every month on the 12th at 04:15 UTC",
  );
});

test("the compact description keeps the facts and drops the filler", () => {
  assert.equal(
    describeCron("0 3 * * *", { compact: true }),
    "Daily, 03:00 UTC",
  );
  assert.equal(
    describeCron("30 9 * * 5", { compact: true }),
    "Weekly, Fri 09:30 UTC",
  );
  assert.equal(
    describeCron("15 4 12 * *", { compact: true }),
    "Monthly, 12th 04:15 UTC",
  );
  // Fixed intervals are already short - compact leaves them alone.
  assert.equal(describeCron("0 * * * *", { compact: true }), "Every hour");
});

test("ordinals read naturally across the offered days", () => {
  const day = (d: number) => describeCron(`0 0 ${d} * *`);
  assert.equal(day(1), "Every month on the 1st at 00:00 UTC");
  assert.equal(day(2), "Every month on the 2nd at 00:00 UTC");
  assert.equal(day(3), "Every month on the 3rd at 00:00 UTC");
  assert.equal(day(4), "Every month on the 4th at 00:00 UTC");
  assert.equal(day(11), "Every month on the 11th at 00:00 UTC");
  assert.equal(day(12), "Every month on the 12th at 00:00 UTC");
  assert.equal(day(13), "Every month on the 13th at 00:00 UTC");
  assert.equal(day(21), "Every month on the 21st at 00:00 UTC");
  assert.equal(day(22), "Every month on the 22nd at 00:00 UTC");
  assert.equal(day(23), "Every month on the 23rd at 00:00 UTC");
});

test("isValidSchedule rejects what the scheduler would silently never run", () => {
  for (const bad of [
    "",
    "0 3 * *",
    "not a cron",
    "60 3 * * *",
    "0 24 * * *",
    "0 3 * * 8",
  ]) {
    assert.equal(
      isValidSchedule(bad),
      false,
      `${JSON.stringify(bad)} should be invalid`,
    );
  }
  assert.ok(isValidSchedule("0 3 * * *"));
});
