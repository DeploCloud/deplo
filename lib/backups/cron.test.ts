import { test } from "node:test";
import assert from "node:assert/strict";

import { parseCron, cronMatches, nextCronRun } from "./cron";

/**
 * The cron matcher is the scheduler's "is this due now?" Bad expressions must
 * degrade to "never matches" — never throw — so one malformed schedule can't crash
 * the tick.
 */

const at = (iso: string) => new Date(iso);

test("every-minute `* * * * *` matches any minute", () => {
  assert.ok(cronMatches("* * * * *", at("2026-06-23T17:45:00Z")));
  assert.ok(cronMatches("* * * * *", at("2026-01-01T00:00:00Z")));
});

test("daily `0 3 * * *` (the UI default) matches only 03:00 UTC", () => {
  assert.ok(cronMatches("0 3 * * *", at("2026-06-23T03:00:00Z")));
  assert.ok(!cronMatches("0 3 * * *", at("2026-06-23T03:01:00Z")));
  assert.ok(!cronMatches("0 3 * * *", at("2026-06-23T04:00:00Z")));
});

test("seconds are ignored (minute precision)", () => {
  assert.ok(cronMatches("45 17 * * *", at("2026-06-23T17:45:59Z")));
});

test("step `*/15` matches every 15th minute, not others", () => {
  for (const m of [0, 15, 30, 45]) {
    assert.ok(
      cronMatches(
        "*/15 * * * *",
        at(`2026-06-23T10:${String(m).padStart(2, "0")}:00Z`),
      ),
    );
  }
  assert.ok(!cronMatches("*/15 * * * *", at("2026-06-23T10:10:00Z")));
});

test("comma list `0,30` matches both, ranges `1-5` are inclusive", () => {
  assert.ok(cronMatches("0,30 * * * *", at("2026-06-23T10:00:00Z")));
  assert.ok(cronMatches("0,30 * * * *", at("2026-06-23T10:30:00Z")));
  assert.ok(!cronMatches("0,30 * * * *", at("2026-06-23T10:15:00Z")));
  // hour 1-5 inclusive
  assert.ok(cronMatches("0 1-5 * * *", at("2026-06-23T01:00:00Z")));
  assert.ok(cronMatches("0 1-5 * * *", at("2026-06-23T05:00:00Z")));
  assert.ok(!cronMatches("0 1-5 * * *", at("2026-06-23T06:00:00Z")));
});

test("range+step `0-30/10` selects 0,10,20,30", () => {
  for (const m of [0, 10, 20, 30]) {
    assert.ok(
      cronMatches(
        "0-30/10 * * * *",
        at(`2026-06-23T10:${String(m).padStart(2, "0")}:00Z`),
      ),
    );
  }
  assert.ok(!cronMatches("0-30/10 * * * *", at("2026-06-23T10:40:00Z")));
});

test("month field is 1-based", () => {
  // June is month 6.
  assert.ok(cronMatches("0 0 1 6 *", at("2026-06-01T00:00:00Z")));
  assert.ok(!cronMatches("0 0 1 6 *", at("2026-07-01T00:00:00Z")));
});

test("day-of-week: 0 and 7 both mean Sunday", () => {
  const sunday = at("2026-06-21T12:00:00Z"); // 2026-06-21 is a Sunday
  assert.equal(sunday.getUTCDay(), 0);
  assert.ok(cronMatches("0 12 * * 0", sunday));
  assert.ok(cronMatches("0 12 * * 7", sunday));
  const monday = at("2026-06-22T12:00:00Z");
  assert.ok(!cronMatches("0 12 * * 0", monday));
});

test("Vixie union rule: both DOM and DOW restricted → either fires", () => {
  // `0 0 13 * 5` = midnight on the 13th OR any Friday.
  const the13th = at("2026-06-13T00:00:00Z"); // a Saturday, not Friday
  assert.equal(the13th.getUTCDay(), 6);
  const aFriday = at("2026-06-19T00:00:00Z"); // the 19th, a Friday
  assert.equal(aFriday.getUTCDay(), 5);
  assert.ok(cronMatches("0 0 13 * 5", the13th)); // matches via DOM
  assert.ok(cronMatches("0 0 13 * 5", aFriday)); // matches via DOW
  const neither = at("2026-06-20T00:00:00Z"); // 20th, Saturday
  assert.ok(!cronMatches("0 0 13 * 5", neither));
});

test("DOW-only `* * * 0` with DOM=* constrains by weekday only", () => {
  const friday = at("2026-06-19T09:30:00Z");
  assert.ok(cronMatches("30 9 * * 5", friday));
  assert.ok(!cronMatches("30 9 * * 5", at("2026-06-20T09:30:00Z"))); // Saturday
});

test("malformed expressions never match and never throw", () => {
  for (const bad of [
    "",
    "* * * *", // 4 fields
    "* * * * * *", // 6 fields
    "60 * * * *", // minute out of range
    "* 24 * * *", // hour out of range
    "* * 0 * *", // DOM below 1
    "* * 32 * *", // DOM above 31
    "* * * 13 *", // month above 12
    "*/0 * * * *", // zero step
    "5-1 * * * *", // inverted range
    "abc * * * *", // non-numeric
    "*/ * * * *", // empty step
  ]) {
    assert.equal(
      parseCron(bad),
      null,
      `expected ${JSON.stringify(bad)} to be unparseable`,
    );
    assert.equal(cronMatches(bad, at("2026-06-23T00:00:00Z")), false);
  }
});

test("whitespace is tolerated between fields", () => {
  assert.ok(cronMatches("  0   3   *   *   *  ", at("2026-06-23T03:00:00Z")));
});

/* ------------------------------------------------------------------ */
/* nextCronRun — the UI's "prove what I just picked actually means"     */
/* ------------------------------------------------------------------ */

const iso = (d: Date | null) => (d === null ? null : d.toISOString());

test("nextCronRun is strictly after `from`, never `from` itself", () => {
  // 03:00 is a match, so the next one is tomorrow's.
  assert.equal(
    iso(nextCronRun("0 3 * * *", at("2026-06-23T03:00:00Z"))),
    "2026-06-24T03:00:00.000Z",
  );
  assert.equal(
    iso(nextCronRun("0 3 * * *", at("2026-06-23T02:59:00Z"))),
    "2026-06-23T03:00:00.000Z",
  );
});

test("nextCronRun ignores the seconds of `from`", () => {
  assert.equal(
    iso(nextCronRun("* * * * *", at("2026-06-23T10:00:30Z"))),
    "2026-06-23T10:01:00.000Z",
  );
});

test("nextCronRun walks steps, weekdays and months", () => {
  assert.equal(
    iso(nextCronRun("*/15 * * * *", at("2026-06-23T10:07:00Z"))),
    "2026-06-23T10:15:00.000Z",
  );
  // 2026-06-23 is a Tuesday; the next Friday 09:30 is the 26th.
  assert.equal(
    iso(nextCronRun("30 9 * * 5", at("2026-06-23T10:00:00Z"))),
    "2026-06-26T09:30:00.000Z",
  );
  assert.equal(
    iso(nextCronRun("0 0 1 * *", at("2026-06-23T10:00:00Z"))),
    "2026-07-01T00:00:00.000Z",
  );
  // A yearly schedule must not need a per-minute walk to resolve.
  assert.equal(
    iso(nextCronRun("0 0 1 1 *", at("2026-06-23T10:00:00Z"))),
    "2027-01-01T00:00:00.000Z",
  );
});

test("nextCronRun honours the Vixie day union", () => {
  // "the 13th OR any Friday" — 2026-06-23 is a Tuesday, so Friday the 26th wins.
  assert.equal(
    iso(nextCronRun("0 0 13 * 5", at("2026-06-23T10:00:00Z"))),
    "2026-06-26T00:00:00.000Z",
  );
});

test("nextCronRun is null when the expression can never fire", () => {
  assert.equal(nextCronRun("nonsense", at("2026-06-23T10:00:00Z")), null);
  // The 30th of February parses fine and simply never comes around.
  assert.equal(nextCronRun("0 0 30 2 *", at("2026-06-23T10:00:00Z")), null);
});
