import { test } from "node:test";
import assert from "node:assert/strict";

import {
  canonicalTimeZone,
  cronMatchesInZone,
  dedupeKeyFor,
  dstSkipWarning,
  nextCronRunInZone,
  pinsHour,
  zoneParts,
} from "./cron-tz";

function minutes(fromIso: string, toIso: string): Date[] {
  const out: Date[] = [];
  for (let t = Date.parse(fromIso); t < Date.parse(toIso); t += 60_000) {
    out.push(new Date(t));
  }
  return out;
}

const firesAt = (expr: string, tz: string, from: string, to: string) =>
  minutes(from, to).filter((m) => cronMatchesInZone(expr, m, tz));

test("reads the wall clock of the zone, not of the host", () => {
  const p = zoneParts(new Date("2026-07-15T12:00:00Z"), "Europe/Rome");
  assert.deepEqual(p, { y: 2026, m: 7, d: 15, H: 14, M: 0 });
  const w = zoneParts(new Date("2026-01-15T12:00:00Z"), "Europe/Rome");
  assert.deepEqual(w, { y: 2026, m: 1, d: 15, H: 13, M: 0 });
});

test("midnight is hour 0, not hour 24", () => {
  assert.equal(zoneParts(new Date("2026-03-10T00:00:00Z"), "UTC").H, 0);
  assert.equal(
    firesAt(
      "0 0 * * *",
      "Europe/Rome",
      "2026-03-09T22:00:00Z",
      "2026-03-10T02:00:00Z",
    ).length,
    1,
    "a midnight schedule must fire once",
  );
});

test("a daily schedule fires on the zone's clock", () => {
  const fires = firesAt(
    "0 3 * * *",
    "Europe/Rome",
    "2026-07-15T00:00:00Z",
    "2026-07-16T00:00:00Z",
  );
  assert.equal(fires.length, 1);
  assert.equal(fires[0].toISOString(), "2026-07-15T01:00:00.000Z");
});

test("day-of-week is the zone's day", () => {
  assert.equal(
    cronMatchesInZone(
      "30 1 * * 1",
      new Date("2026-07-12T23:30:00Z"),
      "Europe/Rome",
    ),
    true,
  );
  assert.equal(
    cronMatchesInZone("30 1 * * 1", new Date("2026-07-12T23:30:00Z"), "UTC"),
    false,
    "the same instant is still Sunday in UTC",
  );
});

test("spring forward: an hour-pinned job inside the skipped hour does not run", () => {
  const fires = firesAt(
    "30 2 * * *",
    "Europe/Rome",
    "2026-03-29T00:00:00Z",
    "2026-03-30T00:00:00Z",
  );
  assert.equal(fires.length, 0);
  assert.equal(
    firesAt(
      "30 2 * * *",
      "Europe/Rome",
      "2026-03-28T00:00:00Z",
      "2026-03-29T00:00:00Z",
    ).length,
    1,
  );
});

test("fall back: an hour-pinned job matches twice but dedupes to one fire", () => {
  const matched = firesAt(
    "30 2 * * *",
    "Europe/Rome",
    "2026-10-25T00:00:00Z",
    "2026-10-26T00:00:00Z",
  );
  assert.equal(matched.length, 2, "the wall clock genuinely occurs twice");

  const keys = new Set(
    matched.map((m) => dedupeKeyFor("30 2 * * *", m, "Europe/Rome")),
  );
  assert.equal(keys.size, 1);
});

test("fall back: an interval job keeps all 24 hours of fires", () => {
  const inRepeat = firesAt(
    "*/5 * * * *",
    "Europe/Rome",
    "2026-10-25T00:00:00Z",
    "2026-10-25T02:00:00Z",
  );
  const keys = new Set(
    inRepeat.map((m) => dedupeKeyFor("*/5 * * * *", m, "Europe/Rome")),
  );
  assert.equal(
    keys.size,
    inRepeat.length,
    "no interval fire may be deduped away",
  );

  const wholeDay = firesAt(
    "*/5 * * * *",
    "Europe/Rome",
    "2026-10-25T00:00:00Z",
    "2026-10-26T00:00:00Z",
  );
  assert.equal(
    wholeDay.length,
    288,
    "a 24h UTC window has 288 five-minute slots",
  );
});

test("pinsHour tells the two key kinds apart", () => {
  assert.equal(pinsHour("0 3 * * *"), true);
  assert.equal(pinsHour("30 2,14 * * *"), true);
  assert.equal(pinsHour("*/5 * * * *"), false);
  assert.equal(pinsHour("0 * * * *"), false);
  assert.equal(pinsHour("0 */6 * * *"), false);
});

test("dedupe keys are stable and zone-qualified", () => {
  const at = new Date("2026-07-15T01:00:00Z");
  const rome = dedupeKeyFor("0 3 * * *", at, "Europe/Rome");
  assert.equal(rome, "2026-07-15T03:00@Europe/Rome");
  assert.notEqual(rome, dedupeKeyFor("0 3 * * *", at, "UTC"));
  assert.equal(
    dedupeKeyFor("*/5 * * * *", at, "Europe/Rome"),
    "2026-07-15T01:00",
  );
});

test("southern hemisphere: the shift runs the other way", () => {
  assert.equal(
    firesAt(
      "30 2 * * *",
      "Australia/Sydney",
      "2026-10-03T13:00:00Z",
      "2026-10-04T13:00:00Z",
    ).length,
    0,
  );
});

test("nextCronRunInZone lands on the right instant", () => {
  const next = nextCronRunInZone(
    "0 3 * * *",
    new Date("2026-07-15T05:00:00Z"),
    "Europe/Rome",
  );
  assert.equal(next?.toISOString(), "2026-07-16T01:00:00.000Z");
  assert.equal(zoneParts(next!, "Europe/Rome").H, 3);
});

test("nextCronRunInZone skips a wall clock DST removes", () => {
  const next = nextCronRunInZone(
    "30 2 * * *",
    new Date("2026-03-28T12:00:00Z"),
    "Europe/Rome",
  );
  assert.ok(next, "there is a next run");
  assert.deepEqual(
    {
      d: zoneParts(next!, "Europe/Rome").d,
      H: zoneParts(next!, "Europe/Rome").H,
    },
    { d: 30, H: 2 },
  );
});

test("nextCronRunInZone crosses a fall-back edge without going backwards", () => {
  const from = new Date("2026-10-25T00:45:00Z");
  const next = nextCronRunInZone("*/30 * * * *", from, "Europe/Rome");
  assert.ok(next && next > from, "next run must be in the future");
  assert.equal(next!.toISOString(), "2026-10-25T01:00:00.000Z");
});

test("an unparseable expression never matches and has no next run", () => {
  assert.equal(cronMatchesInZone("not a cron", new Date(), "UTC"), false);
  assert.equal(nextCronRunInZone("not a cron", new Date(), "UTC"), null);
});

test("timezones are validated, not trusted", () => {
  assert.equal(canonicalTimeZone("Europe/Rome"), "Europe/Rome");
  assert.equal(canonicalTimeZone("  UTC  "), "UTC");
  assert.equal(canonicalTimeZone("Mars/Olympus"), null);
  assert.equal(canonicalTimeZone(""), null);
  assert.equal(canonicalTimeZone("'; drop table cron_jobs; --"), null);
});

test("the DST warning fires only on the hour that really disappears", () => {
  const before = new Date("2026-01-10T00:00:00Z");
  assert.equal(
    dstSkipWarning("30 2 * * *", "Europe/Rome", before),
    "Europe/Rome skips 02:00 to 03:00 on March 29, 2026, so nothing runs at this time that day.",
  );
  for (const h of [0, 1, 3, 4]) {
    assert.equal(
      dstSkipWarning(`30 ${h} * * *`, "Europe/Rome", before),
      null,
      `${h}:30 exists`,
    );
  }
  assert.equal(dstSkipWarning("30 2 * * *", "UTC", before), null);
  assert.equal(dstSkipWarning("30 2 * * *", "Asia/Tokyo", before), null);
  assert.equal(dstSkipWarning("*/15 * * * *", "Europe/Rome", before), null);
  assert.equal(dstSkipWarning("30 2 * * 1", "Europe/Rome", before), null);
  assert.ok(dstSkipWarning("30 2 * * *", "Australia/Sydney", before));
  assert.ok(dstSkipWarning("30 2 * * *", "Africa/Casablanca", before));
  assert.ok(dstSkipWarning("15 2 * * *", "Australia/Lord_Howe", before));
  assert.equal(
    dstSkipWarning("45 2 * * *", "Australia/Lord_Howe", before),
    null,
  );
});

test("a macro pins its hour like the expression it expands to", () => {
  assert.ok(pinsHour("@daily"));
  assert.ok(pinsHour("@weekly"));
  assert.ok(!pinsHour("@hourly"));
  assert.ok(pinsHour("0 9 * * MON-FRI"));
  const first = new Date("2026-10-25T00:30:00Z");
  const second = new Date("2026-10-25T01:30:00Z");
  assert.equal(
    dedupeKeyFor("@daily", first, "Europe/Rome"),
    dedupeKeyFor("@daily", second, "Europe/Rome"),
  );
});

test("the picked spelling of a zone survives ICU's aliasing", () => {
  assert.equal(canonicalTimeZone("Asia/Kolkata"), "Asia/Kolkata");
  assert.equal(canonicalTimeZone("europe/rome"), "Europe/Rome");
  assert.equal(canonicalTimeZone("utc"), "UTC");
  assert.equal(canonicalTimeZone("Mars/Olympus"), null);
});
