import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLogWindow, splitTimestamp, MINUTES_PER_DAY } from "./window";

const NOW_MS = 1_756_000_000_000;
const NOW_S = NOW_MS / 1000;

function win(query: string, maxDays = 7) {
  return parseLogWindow(new URLSearchParams(query), maxDays, NOW_MS);
}

test("an absent window is unset, not the epoch and not zero minutes", () => {
  assert.deepEqual(win(""), { sinceUnix: 0, timestamps: false });
  assert.deepEqual(win("sinceMinutes="), { sinceUnix: 0, timestamps: false });
  assert.deepEqual(win("sinceMinutes=abc"), {
    sinceUnix: 0,
    timestamps: false,
  });
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
  assert.equal(
    win("sinceMinutes=43200", 1).sinceUnix,
    NOW_S - MINUTES_PER_DAY * 60,
  );
  assert.equal(win("sinceMinutes=5", 0).sinceUnix, NOW_S - 5 * 60);
});

test("timestamps reads both spellings the client might send", () => {
  assert.equal(win("timestamps=1").timestamps, true);
  assert.equal(win("timestamps=true").timestamps, true);
  assert.equal(win("timestamps=0").timestamps, false);
  assert.equal(win("").timestamps, false);
});

test("splitTimestamp reads what docker actually writes", () => {
  const real =
    '2026-08-24T16:23:39.267596474Z {"level":"info","msg":"listening on :3000"}';
  assert.deepEqual(splitTimestamp(real), {
    ts: "2026-08-24T16:23:39.267596474Z",
    rest: '{"level":"info","msg":"listening on :3000"}',
  });

  assert.deepEqual(
    splitTimestamp("2026-08-24T16:23:39.267Z \u001b[32m✓\u001b[0m ok"),
    {
      ts: "2026-08-24T16:23:39.267Z",
      rest: "\u001b[32m✓\u001b[0m ok",
    },
  );

  assert.deepEqual(splitTimestamp("plain line"), {
    ts: null,
    rest: "plain line",
  });
  assert.deepEqual(splitTimestamp(""), { ts: null, rest: "" });
  assert.deepEqual(
    splitTimestamp("2026-08-24 10:00:00.000 UTC [1] LOG:  ready"),
    { ts: null, rest: "2026-08-24 10:00:00.000 UTC [1] LOG:  ready" },
  );
});

test("the whole line survives: prefix off, message byte-identical", () => {
  const body = "msg with\nan embedded newline";
  const { ts, rest } = splitTimestamp(`2026-08-24T16:23:39.267596474Z ${body}`);
  assert.equal(ts, "2026-08-24T16:23:39.267596474Z");
  assert.equal(rest, body);
});
