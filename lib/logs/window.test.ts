import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLogWindow, MINUTES_PER_DAY } from "./window";

const NOW_MS = 1_756_000_000_000; // fixed clock; the function takes it as a param
const NOW_S = NOW_MS / 1000;

function win(query: string, maxDays = 7) {
  return parseLogWindow(new URLSearchParams(query), maxDays, NOW_MS);
}

test("an absent window is unset, not the epoch and not zero minutes", () => {
  // Number(null) is a finite 0, and "0 minutes ago" is an empty stream. Absent
  // has to mean 0 == the agent's "no lower bound", which streams --tail as before.
  assert.deepEqual(win(""), { sinceUnix: 0, timestamps: false });
  assert.deepEqual(win("sinceMinutes="), { sinceUnix: 0, timestamps: false });
  assert.deepEqual(win("sinceMinutes=abc"), { sinceUnix: 0, timestamps: false });
  assert.deepEqual(win("sinceMinutes=0"), { sinceUnix: 0, timestamps: false });
  assert.deepEqual(win("sinceMinutes=-5"), { sinceUnix: 0, timestamps: false });
});

test("a duration becomes an instant on the SERVER's clock", () => {
  assert.equal(win("sinceMinutes=30").sinceUnix, NOW_S - 30 * 60);
  assert.equal(win("sinceMinutes=60").sinceUnix, NOW_S - 60 * 60);
  assert.equal(
    win(`sinceMinutes=${MINUTES_PER_DAY}`).sinceUnix,
    NOW_S - MINUTES_PER_DAY * 60,
  );
});

test("the instance ceiling clamps, it does not reject", () => {
  const sevenDays = 7 * MINUTES_PER_DAY;
  assert.equal(win("sinceMinutes=999999", 7).sinceUnix, NOW_S - sevenDays * 60);
  // A ceiling of 1 day pins even a "last 30 days" request to a day.
  assert.equal(
    win("sinceMinutes=43200", 1).sinceUnix,
    NOW_S - MINUTES_PER_DAY * 60,
  );
  // A nonsense ceiling still leaves at least a minute of window.
  assert.equal(win("sinceMinutes=5", 0).sinceUnix, NOW_S - 5 * 60);
});

test("timestamps reads both spellings the client might send", () => {
  assert.equal(win("timestamps=1").timestamps, true);
  assert.equal(win("timestamps=true").timestamps, true);
  assert.equal(win("timestamps=0").timestamps, false);
  assert.equal(win("").timestamps, false);
});
