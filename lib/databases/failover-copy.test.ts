import { test } from "node:test";
import assert from "node:assert/strict";

import { lossSentence, restoredSentence } from "./failover-copy";

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

test("lossSentence: about a minute once the change log is archived, never without a backup to replay it onto", () => {
  assert.equal(
    lossSentence(15, true),
    "A failover can lose about a minute of writes while Deplo is running: it collects the change log every minute. If Deplo is down too, the loss is everything written since it stopped.",
  );
  assert.equal(lossSentence(null, true), lossSentence(null));
});

test("restoredSentence: adds how far the change log reached, with the date when it is another day's", () => {
  const now = new Date("2026-03-01T15:00:00Z");
  const said = (logAt: string | null) =>
    restoredSentence(
      "db",
      "server-b",
      "2026-03-01T14:15:00Z",
      "UTC",
      now,
      logAt,
    );
  assert.equal(
    said("2026-03-01T14:27:10Z"),
    "Restored db on server-b from the backup of 14:15 and its change log up to 14:27",
  );
  assert.equal(
    said("2026-03-02T00:03:00Z"),
    "Restored db on server-b from the backup of 14:15 and its change log up to 2 Mar, 00:03",
  );
  // A change log that ends before the backup adds nothing to it.
  assert.equal(
    said("2026-03-01T14:00:00Z"),
    "Restored db on server-b from the backup of 14:15",
  );
  assert.equal(said(null), "Restored db on server-b from the backup of 14:15");
});
