import { test } from "node:test";
import assert from "node:assert/strict";

import { restoredSentence } from "./failover-copy";

const NOW = new Date("2026-03-01T14:32:00.000Z");

test("a failover names the backup it restored by its time", () => {
  assert.equal(
    restoredSentence("db", "server-b", "2026-03-01T14:15:00.000Z", "UTC", NOW),
    "Restored db on server-b from the backup of 14:15",
  );
});

test("the time is read in the backup schedule's timezone", () => {
  assert.equal(
    restoredSentence(
      "db",
      "server-b",
      "2026-03-01T14:15:00.000Z",
      "Europe/Rome",
      NOW,
    ),
    "Restored db on server-b from the backup of 15:15",
  );
});

test("a backup of another day carries its date, so an old one is never read as today's", () => {
  assert.equal(
    restoredSentence("db", "server-b", "2026-02-27T03:00:00.000Z", "UTC", NOW),
    "Restored db on server-b from the backup of 27 Feb, 03:00",
  );
});

test("a failover that does not say when the backup was taken still says it was restored", () => {
  assert.equal(
    restoredSentence("db", "server-b", null, "UTC", NOW),
    "Restored db on server-b from its latest backup",
  );
  assert.equal(
    restoredSentence("db", "server-b", "not a date", "UTC", NOW),
    "Restored db on server-b from its latest backup",
  );
});

test("a timezone this runtime does not know falls back to UTC", () => {
  assert.equal(
    restoredSentence(
      "db",
      "server-b",
      "2026-03-01T14:15:00.000Z",
      "Mars/Olympus",
      NOW,
    ),
    "Restored db on server-b from the backup of 14:15",
  );
});
