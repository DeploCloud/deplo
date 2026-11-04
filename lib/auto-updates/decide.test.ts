import { test } from "node:test";
import assert from "node:assert/strict";

import type { UpdateLogEntry } from "../data/update-log";
import { decideAutoUpdate, installsAt, type AutoUpdateInput } from "./decide";

const NOW = new Date("2026-11-05T02:10:00Z");

const base: AutoUpdateInput = {
  now: NOW,
  hour: 2,
  timezone: "UTC",
  active: true,
  postponedUntil: null,
  next: "v0.9.1",
  nextPublishedAt: "2026-11-03T10:00:00Z",
  securityFix: false,
  manualUpdate: null,
  log: [],
  busy: null,
};

const row = (over: Partial<UpdateLogEntry>): UpdateLogEntry => ({
  id: "dupd_x",
  trigger: "automatic",
  outcome: "updated",
  fromVersion: "v0.9.0",
  toVersion: "v0.9.1",
  actor: null,
  reason: null,
  at: "2026-11-01T02:00:00.000Z",
  finishedAt: null,
  ...over,
});

const decide = (over: Partial<AutoUpdateInput>) =>
  decideAutoUpdate({ ...base, ...over });

test("in a slot, with nothing running, the matured release installs", () => {
  assert.deepEqual(decide({}), { kind: "install", version: "v0.9.1" });
});

test("nothing happens off, paused, up to date or between windows", () => {
  assert.equal(decide({ active: false }).kind, "wait");
  assert.equal(decide({ next: null }).kind, "wait");
  assert.equal(decide({ now: new Date("2026-11-05T12:00:00Z") }).kind, "wait");
});

test("a release under 24 hours old waits, unless it fixes a security flaw", () => {
  const fresh = { nextPublishedAt: "2026-11-04T20:00:00Z" };
  assert.equal(decide(fresh).kind, "wait");
  assert.equal(decide({ ...fresh, securityFix: true }).kind, "install");
});

test("work a restart would break skips the slot, naming the next try", () => {
  assert.deepEqual(decide({ busy: "A deploy was running" }), {
    kind: "skip",
    version: "v0.9.1",
    reason: "A deploy was running. Deplo tries again at 03:00.",
  });
  const last = decide({
    now: new Date("2026-11-05T04:10:00Z"),
    busy: "A backup was running",
  });
  assert.equal(
    last.kind === "skip" && last.reason,
    "A backup was running. Deplo tries again tomorrow at 02:00.",
  );
});

test("one answer per slot", () => {
  const skipped = row({ outcome: "skipped", at: "2026-11-05T02:05:00.000Z" });
  assert.equal(decide({ log: [skipped] }).kind, "wait");
  const earlier = row({ outcome: "skipped", at: "2026-11-05T01:59:00.000Z" });
  assert.equal(decide({ log: [earlier] }).kind, "install");
});

test("a release that declares a manual step is held once, then left alone", () => {
  const manual = { manualUpdate: "Move your backups first." };
  assert.deepEqual(decide(manual), {
    kind: "hold",
    version: "v0.9.1",
    reason: "Move your backups first.",
  });
  const held = row({ outcome: "held", at: "2026-11-04T02:00:00.000Z" });
  assert.equal(decide({ ...manual, log: [held] }).kind, "wait");
});

test("a failed night waits for the next one, and three stop Deplo on that version", () => {
  const tonight = row({
    outcome: "rolled_back",
    at: "2026-11-05T02:01:00.000Z",
  });
  assert.equal(
    decide({ now: new Date("2026-11-05T03:10:00Z"), log: [tonight] }).kind,
    "wait",
  );
  const nights = ["2026-11-02", "2026-11-03", "2026-11-04"].map((d, i) =>
    row({
      id: `f${i}`,
      outcome: i ? "rolled_back" : "failed",
      at: `${d}T02:00:00.000Z`,
    }),
  );
  assert.equal(decide({ log: nights.slice(0, 2) }).kind, "install");
  const gaveUp = decide({ log: nights });
  assert.equal(gaveUp.kind, "hold");
  // A failure on another version counts for nothing here.
  assert.equal(
    decide({ log: nights.map((e) => ({ ...e, toVersion: "v0.9.0" })) }).kind,
    "install",
  );
});

test("a postponed night is skipped", () => {
  assert.equal(
    decide({ postponedUntil: "2026-11-05T05:00:00.000Z" }).kind,
    "wait",
  );
  assert.equal(
    decide({ postponedUntil: "2026-11-05T02:00:00.000Z" }).kind,
    "install",
  );
});

test("installsAt: the next slot after the release matures and the night skipped", () => {
  const noon = { ...base, now: new Date("2026-11-05T12:00:00Z") };
  assert.equal(installsAt(noon)?.toISOString(), "2026-11-06T02:00:00.000Z");
  assert.equal(
    installsAt({
      ...noon,
      nextPublishedAt: "2026-11-05T11:00:00Z",
    })?.toISOString(),
    "2026-11-07T02:00:00.000Z",
    "matures at 11:00 tomorrow, so the night after",
  );
  assert.equal(
    installsAt({
      ...noon,
      postponedUntil: "2026-11-06T05:00:00.000Z",
    })?.toISOString(),
    "2026-11-07T02:00:00.000Z",
  );
  assert.equal(installsAt({ ...noon, manualUpdate: "Read it." }), null);
  assert.equal(installsAt({ ...noon, active: false }), null);
  // Inside a slot nobody has answered yet: any moment now.
  assert.equal(installsAt(base)?.toISOString(), NOW.toISOString());
});
