import { test } from "node:test";
import assert from "node:assert/strict";

import { reconcileStatus } from "./services";

const NOW = Date.UTC(2026, 0, 1, 12, 0, 0); // fixed clock for deterministic age
const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();

test("reconcileStatus: non-stopping statuses pass through unchanged", () => {
  for (const s of ["active", "building", "error", "queued", "idle"] as const) {
    assert.equal(reconcileStatus(s, at(10_000_000), NOW), s);
  }
});

test("reconcileStatus: a fresh 'stopping' stays 'stopping'", () => {
  // Within the stop timeout window — the stop is still legitimately in flight.
  assert.equal(reconcileStatus("stopping", at(5_000), NOW), "stopping");
});

test("reconcileStatus: a stale 'stopping' self-heals to 'idle'", () => {
  // Older than the 90s stop timeout → the server likely died mid-stop; report
  // the stop's intended terminal state instead of wedging on "stopping".
  assert.equal(reconcileStatus("stopping", at(120_000), NOW), "idle");
});

test("reconcileStatus: exactly at the threshold is still 'stopping'", () => {
  // Boundary is exclusive (> threshold heals), so 90s on the nose stays.
  assert.equal(reconcileStatus("stopping", at(90_000), NOW), "stopping");
});
