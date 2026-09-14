import { test } from "node:test";
import assert from "node:assert/strict";

import { parseCron, cronMatches, nextCronRun } from "./cron";

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
  assert.ok(cronMatches("0 0 1 6 *", at("2026-06-01T00:00:00Z")));
  assert.ok(!cronMatches("0 0 1 6 *", at("2026-07-01T00:00:00Z")));
});

test("day-of-week: 0 and 7 both mean Sunday", () => {
  const sunday = at("2026-06-21T12:00:00Z");
  assert.equal(sunday.getUTCDay(), 0);
  assert.ok(cronMatches("0 12 * * 0", sunday));
  assert.ok(cronMatches("0 12 * * 7", sunday));
  const monday = at("2026-06-22T12:00:00Z");
  assert.ok(!cronMatches("0 12 * * 0", monday));
});

test("Vixie union rule: both DOM and DOW restricted → either fires", () => {
  const the13th = at("2026-06-13T00:00:00Z");
  assert.equal(the13th.getUTCDay(), 6);
  const aFriday = at("2026-06-19T00:00:00Z");
  assert.equal(aFriday.getUTCDay(), 5);
  assert.ok(cronMatches("0 0 13 * 5", the13th));
  assert.ok(cronMatches("0 0 13 * 5", aFriday));
  const neither = at("2026-06-20T00:00:00Z");
  assert.ok(!cronMatches("0 0 13 * 5", neither));
});

test("DOW-only `* * * 0` with DOM=* constrains by weekday only", () => {
  const friday = at("2026-06-19T09:30:00Z");
  assert.ok(cronMatches("30 9 * * 5", friday));
  assert.ok(!cronMatches("30 9 * * 5", at("2026-06-20T09:30:00Z")));
});

test("malformed expressions never match and never throw", () => {
  for (const bad of [
    "",
    "* * * *",
    "* * * * * *",
    "60 * * * *",
    "* 24 * * *",
    "* * 0 * *",
    "* * 32 * *",
    "* * * 13 *",
    "*/0 * * * *",
    "5-1 * * * *",
    "abc * * * *",
    "*/ * * * *",
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

const iso = (d: Date | null) => (d === null ? null : d.toISOString());

test("nextCronRun is strictly after `from`, never `from` itself", () => {
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
  assert.equal(
    iso(nextCronRun("30 9 * * 5", at("2026-06-23T10:00:00Z"))),
    "2026-06-26T09:30:00.000Z",
  );
  assert.equal(
    iso(nextCronRun("0 0 1 * *", at("2026-06-23T10:00:00Z"))),
    "2026-07-01T00:00:00.000Z",
  );
  assert.equal(
    iso(nextCronRun("0 0 1 1 *", at("2026-06-23T10:00:00Z"))),
    "2027-01-01T00:00:00.000Z",
  );
});

test("nextCronRun honours the Vixie day union", () => {
  assert.equal(
    iso(nextCronRun("0 0 13 * 5", at("2026-06-23T10:00:00Z"))),
    "2026-06-26T00:00:00.000Z",
  );
});

test("nextCronRun is null when the expression can never fire", () => {
  assert.equal(nextCronRun("nonsense", at("2026-06-23T10:00:00Z")), null);
  assert.equal(nextCronRun("0 0 30 2 *", at("2026-06-23T10:00:00Z")), null);
});

test("weekday and month names are read, in any case", () => {
  assert.ok(cronMatches("0 9 * * MON-FRI", at("2026-09-07T09:00:00Z")));
  assert.ok(!cronMatches("0 9 * * MON-FRI", at("2026-09-06T09:00:00Z")));
  assert.ok(cronMatches("0 9 * * mon,wed", at("2026-09-09T09:00:00Z")));
  assert.ok(cronMatches("0 0 1 JAN *", at("2026-01-01T00:00:00Z")));
  assert.ok(cronMatches("0 0 1 jan-mar *", at("2026-02-01T00:00:00Z")));
  assert.ok(!cronMatches("0 0 1 jan-mar *", at("2026-04-01T00:00:00Z")));
  assert.equal(parseCron("0 9 * * MON-FRX"), null);
  assert.equal(parseCron("0 9 * * JAN"), null, "a month name is not a weekday");
});

test("the Vixie macros expand; @reboot is not a schedule", () => {
  assert.ok(cronMatches("@daily", at("2026-09-06T00:00:00Z")));
  assert.ok(!cronMatches("@daily", at("2026-09-06T00:01:00Z")));
  assert.ok(cronMatches("@hourly", at("2026-09-06T13:00:00Z")));
  assert.ok(cronMatches("@weekly", at("2026-09-06T00:00:00Z")));
  assert.ok(cronMatches("@MONTHLY", at("2026-10-01T00:00:00Z")));
  assert.ok(cronMatches("@yearly", at("2027-01-01T00:00:00Z")));
  assert.equal(
    nextCronRun("@monthly", at("2026-09-06T00:00:00Z"))?.toISOString(),
    "2026-10-01T00:00:00.000Z",
  );
  assert.equal(parseCron("@reboot"), null);
  assert.equal(parseCron("@every 5m"), null);
});

test("`5/15` steps from 5 to the end of the field", () => {
  assert.ok(cronMatches("5/15 * * * *", at("2026-09-06T13:05:00Z")));
  assert.ok(cronMatches("5/15 * * * *", at("2026-09-06T13:20:00Z")));
  assert.ok(cronMatches("5/15 * * * *", at("2026-09-06T13:50:00Z")));
  assert.ok(!cronMatches("5/15 * * * *", at("2026-09-06T13:15:00Z")));
  assert.ok(cronMatches("5 * * * *", at("2026-09-06T13:05:00Z")));
  assert.ok(
    !cronMatches("5 * * * *", at("2026-09-06T13:20:00Z")),
    "a bare number stays itself",
  );
});
