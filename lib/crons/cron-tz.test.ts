import { test } from "node:test";
import assert from "node:assert/strict";

import {
  canonicalTimeZone,
  cronMatchesInZone,
  dedupeKeyFor,
  dstSkipWarning,
  nextCronRunInZone,
  pinsHour,
  zoneHasDst,
  zoneParts,
} from "./cron-tz";

/** Every UTC minute in `[from, to)`, the shape the scheduler's tick sees. */
function minutes(fromIso: string, toIso: string): Date[] {
  const out: Date[] = [];
  for (
    let t = Date.parse(fromIso);
    t < Date.parse(toIso);
    t += 60_000
  ) {
    out.push(new Date(t));
  }
  return out;
}

const firesAt = (expr: string, tz: string, from: string, to: string) =>
  minutes(from, to).filter((m) => cronMatchesInZone(expr, m, tz));

test("reads the wall clock of the zone, not of the host", () => {
  // 12:00 UTC is 14:00 in Rome in summer (CEST, +02:00).
  const p = zoneParts(new Date("2026-07-15T12:00:00Z"), "Europe/Rome");
  assert.deepEqual(p, { y: 2026, m: 7, d: 15, H: 14, M: 0 });
  // And 13:00 in winter (CET, +01:00). Same instant-to-wall function, both ways.
  const w = zoneParts(new Date("2026-01-15T12:00:00Z"), "Europe/Rome");
  assert.deepEqual(w, { y: 2026, m: 1, d: 15, H: 13, M: 0 });
});

test("midnight is hour 0, not hour 24", () => {
  // The `hourCycle: "h23"` guard. Without it en-US formats midnight as "24" and
  // `0 0 * * *` never fires - silently, once a day, in every zone.
  assert.equal(zoneParts(new Date("2026-03-10T00:00:00Z"), "UTC").H, 0);
  assert.equal(
    firesAt("0 0 * * *", "Europe/Rome", "2026-03-09T22:00:00Z", "2026-03-10T02:00:00Z").length,
    1,
    "a midnight schedule must fire once",
  );
});

test("a daily schedule fires on the zone's clock", () => {
  // 03:00 Rome in July is 01:00 UTC. A UTC-only evaluator would fire at 03:00Z.
  const fires = firesAt("0 3 * * *", "Europe/Rome", "2026-07-15T00:00:00Z", "2026-07-16T00:00:00Z");
  assert.equal(fires.length, 1);
  assert.equal(fires[0].toISOString(), "2026-07-15T01:00:00.000Z");
});

test("day-of-week is the zone's day", () => {
  // 2026-07-13 is a Monday. 23:30 UTC on Sunday the 12th is already Monday
  // 01:30 in Rome, so a Monday schedule must fire there and NOT 24h later.
  assert.equal(
    cronMatchesInZone("30 1 * * 1", new Date("2026-07-12T23:30:00Z"), "Europe/Rome"),
    true,
  );
  assert.equal(
    cronMatchesInZone("30 1 * * 1", new Date("2026-07-12T23:30:00Z"), "UTC"),
    false,
    "the same instant is still Sunday in UTC",
  );
});

test("spring forward: an hour-pinned job inside the skipped hour does not run", () => {
  // Europe/Rome jumps 02:00 -> 03:00 on 2026-03-29. Wall-clock 02:30 does not
  // exist that day, so the schedule matches no instant. Documented in ADR-0018.
  const fires = firesAt("30 2 * * *", "Europe/Rome", "2026-03-29T00:00:00Z", "2026-03-30T00:00:00Z");
  assert.equal(fires.length, 0);
  // The day before and the day after are unaffected.
  assert.equal(
    firesAt("30 2 * * *", "Europe/Rome", "2026-03-28T00:00:00Z", "2026-03-29T00:00:00Z").length,
    1,
  );
});

test("fall back: an hour-pinned job matches twice but dedupes to one fire", () => {
  // Europe/Rome falls back 03:00 -> 02:00 on 2026-10-25: wall-clock 02:30
  // happens at 00:30Z and again at 01:30Z.
  const matched = firesAt("30 2 * * *", "Europe/Rome", "2026-10-25T00:00:00Z", "2026-10-26T00:00:00Z");
  assert.equal(matched.length, 2, "the wall clock genuinely occurs twice");

  // The wall-clock key collapses them, which is what "every day at 02:30" means.
  const keys = new Set(matched.map((m) => dedupeKeyFor("30 2 * * *", m, "Europe/Rome")));
  assert.equal(keys.size, 1);
});

test("fall back: an interval job keeps all 24 hours of fires", () => {
  // The same day is 25 real hours long, and "every 5 minutes" means every five
  // minutes. Keyed on the wall clock this would collapse to 12 fires in the
  // repeated hour; keyed on the instant it stays at 24.
  // 00:00Z-02:00Z on that date is the two real hours that both read 02:xx local.
  const inRepeat = firesAt("*/5 * * * *", "Europe/Rome", "2026-10-25T00:00:00Z", "2026-10-25T02:00:00Z");
  const keys = new Set(inRepeat.map((m) => dedupeKeyFor("*/5 * * * *", m, "Europe/Rome")));
  assert.equal(keys.size, inRepeat.length, "no interval fire may be deduped away");

  const wholeDay = firesAt("*/5 * * * *", "Europe/Rome", "2026-10-25T00:00:00Z", "2026-10-26T00:00:00Z");
  assert.equal(wholeDay.length, 288, "a 24h UTC window has 288 five-minute slots");
});

test("pinsHour tells the two key kinds apart", () => {
  assert.equal(pinsHour("0 3 * * *"), true);
  assert.equal(pinsHour("30 2,14 * * *"), true);
  assert.equal(pinsHour("*/5 * * * *"), false);
  assert.equal(pinsHour("0 * * * *"), false);
  // Documented ceiling: a stepped hour reads as an interval.
  assert.equal(pinsHour("0 */6 * * *"), false);
});

test("dedupe keys are stable and zone-qualified", () => {
  const at = new Date("2026-07-15T01:00:00Z");
  const rome = dedupeKeyFor("0 3 * * *", at, "Europe/Rome");
  assert.equal(rome, "2026-07-15T03:00@Europe/Rome");
  // The same instant under a different zone is a different fire.
  assert.notEqual(rome, dedupeKeyFor("0 3 * * *", at, "UTC"));
  // An interval key is the instant, to the minute.
  assert.equal(dedupeKeyFor("*/5 * * * *", at, "Europe/Rome"), "2026-07-15T01:00");
});

test("southern hemisphere: the shift runs the other way", () => {
  // Australia/Sydney springs forward on 2026-10-04 (02:00 -> 03:00), months
  // after the northern zones and in the opposite season.
  assert.equal(
    firesAt("30 2 * * *", "Australia/Sydney", "2026-10-03T13:00:00Z", "2026-10-04T13:00:00Z").length,
    0,
  );
  assert.equal(zoneHasDst("Australia/Sydney"), true);
  assert.equal(zoneHasDst("UTC"), false);
  assert.equal(zoneHasDst("Asia/Tokyo"), false);
});

test("nextCronRunInZone lands on the right instant", () => {
  const next = nextCronRunInZone("0 3 * * *", new Date("2026-07-15T05:00:00Z"), "Europe/Rome");
  // 03:00 Rome the next morning = 01:00Z on the 16th.
  assert.equal(next?.toISOString(), "2026-07-16T01:00:00.000Z");
  assert.equal(zoneParts(next!, "Europe/Rome").H, 3);
});

test("nextCronRunInZone skips a wall clock DST removes", () => {
  // Asked on 2026-03-28, the next 02:30 Rome is NOT the 29th (it does not exist)
  // but the 30th.
  const next = nextCronRunInZone("30 2 * * *", new Date("2026-03-28T12:00:00Z"), "Europe/Rome");
  assert.ok(next, "there is a next run");
  assert.deepEqual(
    { d: zoneParts(next!, "Europe/Rome").d, H: zoneParts(next!, "Europe/Rome").H },
    { d: 30, H: 2 },
  );
});

test("nextCronRunInZone crosses a fall-back edge without going backwards", () => {
  const from = new Date("2026-10-25T00:45:00Z"); // inside the repeated hour
  const next = nextCronRunInZone("*/30 * * * *", from, "Europe/Rome");
  assert.ok(next && next > from, "next run must be in the future");
  assert.equal(next!.toISOString(), "2026-10-25T01:00:00.000Z");
});

test("an unparseable expression never matches and has no next run", () => {
  // One malformed row must not be able to throw inside the scheduler tick.
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

test("the DST warning fires only where it can bite", () => {
  assert.ok(dstSkipWarning("30 2 * * *", "Europe/Rome"));
  // No DST in the zone: nothing to warn about.
  assert.equal(dstSkipWarning("30 2 * * *", "UTC"), null);
  // Outside the window every transition on earth happens in.
  assert.equal(dstSkipWarning("0 14 * * *", "Europe/Rome"), null);
  // An interval schedule cannot lose a fire it never pinned.
  assert.equal(dstSkipWarning("*/15 * * * *", "Europe/Rome"), null);
});
