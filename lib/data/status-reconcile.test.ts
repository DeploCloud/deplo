import { test } from "node:test";
import assert from "node:assert/strict";

import { reconcileStatus } from "./apps/summary";
import { BACKUP_RUN_MAX_MS } from "../infra/agent-client/deadlines";

const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);
const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();

test("reconcileStatus: non-stopping statuses pass through unchanged", () => {
  for (const s of ["active", "building", "error", "queued", "idle"] as const) {
    assert.equal(reconcileStatus(s, at(10_000_000), NOW), s);
  }
});

test("reconcileStatus: a fresh 'stopping' stays 'stopping'", () => {
  assert.equal(reconcileStatus("stopping", at(5_000), NOW), "stopping");
});

test("reconcileStatus: a stale 'stopping' self-heals to 'idle'", () => {
  assert.equal(reconcileStatus("stopping", at(120_000), NOW), "idle");
});

test("reconcileStatus: exactly at the threshold is still 'stopping'", () => {
  assert.equal(reconcileStatus("stopping", at(90_000), NOW), "stopping");
});

test("reconcileStatus: a fresh 'restoring' stays 'restoring'", () => {
  assert.equal(reconcileStatus("restoring", at(60 * 60_000), NOW), "restoring");
});

test("reconcileStatus: a stale 'restoring' self-heals to 'error'", () => {
  assert.equal(
    reconcileStatus("restoring", at(BACKUP_RUN_MAX_MS + 60_000), NOW),
    "error",
  );
});
