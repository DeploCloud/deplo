import { test } from "node:test";
import assert from "node:assert/strict";

import type { UpdateLogEntry } from "@/lib/data/update-log";
import { entrySentence, logWhen, updateLogActor } from "./update-log-dialog";

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

test("each entry says when, on the window's clock", () => {
  const now = new Date("2026-11-05T12:00:00Z");
  const when = (at: string) => logWhen(at, "Europe/Rome", now);
  assert.equal(when("2026-11-05T02:01:00.000Z"), "Today 03:01");
  // 23:30 UTC on the 3rd is already the 4th in Rome.
  assert.equal(when("2026-11-03T23:30:00.000Z"), "Yesterday 00:30");
  assert.equal(when("2026-11-01T01:00:00.000Z"), "1 Nov 02:00");
  assert.equal(when("2025-12-24T10:00:00.000Z"), "24 Dec 2025 11:00");
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
