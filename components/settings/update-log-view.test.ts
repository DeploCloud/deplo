import { test } from "node:test";
import assert from "node:assert/strict";

import type { UpdateLogEntry } from "@/lib/data/update-log";
import { entrySentence, groupByDay, updateLogActor } from "./update-log-view";

const e = (over: Partial<UpdateLogEntry>): UpdateLogEntry => ({
  id: over.at ?? "x",
  trigger: "automatic",
  outcome: "updated",
  fromVersion: "v0.9.0",
  toVersion: "v0.9.1",
  actor: null,
  reason: null,
  at: "2026-11-05T02:00:00.000Z",
  finishedAt: null,
  ...over,
});

test("entries group by day on the window's clock, newest first", () => {
  const now = new Date("2026-11-05T12:00:00Z");
  const days = groupByDay(
    [
      e({ at: "2026-11-05T02:01:00.000Z" }),
      e({ at: "2026-11-05T01:00:00.000Z", outcome: "skipped" }),
      // 23:30 UTC on the 3rd is already the 4th in Rome.
      e({ at: "2026-11-03T23:30:00.000Z", outcome: "postponed" }),
      e({ at: "2026-11-01T01:00:00.000Z", outcome: "rolled_back" }),
      e({ at: "2025-12-24T10:00:00.000Z", trigger: "host" }),
    ],
    "Europe/Rome",
    now,
  );
  assert.deepEqual(
    days.map((d) => [d.label, d.items.map((i) => i.time)]),
    [
      ["Today", ["03:01", "02:00"]],
      ["Yesterday", ["00:30"]],
      ["1 Nov", ["02:00"]],
      ["24 Dec 2025", ["11:00"]],
    ],
  );
});

test("each entry reads as one sentence, and says who started it", () => {
  assert.equal(entrySentence(e({})), "Updated to v0.9.1");
  assert.equal(entrySentence(e({ outcome: "skipped" })), "Waited on v0.9.1");
  assert.equal(entrySentence(e({ outcome: "held" })), "v0.9.1 needs you");
  assert.equal(updateLogActor(e({})), "Automatic");
  assert.equal(updateLogActor(e({ trigger: "host" })), "Installer");
  assert.equal(updateLogActor(e({ trigger: "button", actor: "Bob" })), "Bob");
  assert.equal(
    updateLogActor(
      e({ trigger: "automatic", actor: "Alice", outcome: "postponed" }),
    ),
    "Alice",
  );
});
