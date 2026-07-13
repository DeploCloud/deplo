import { test } from "node:test";
import assert from "node:assert/strict";
import { displayStatus, type RuntimeSnapshot } from "./display-status";

const runtime = (over: Partial<RuntimeSnapshot> = {}): RuntimeSnapshot => ({
  total: 1,
  running: 1,
  restarting: 0,
  unhealthy: 0,
  missing: [],
  unreachable: false,
  ...over,
});

/**
 * The bug these lock down: `apps.status` is the last thing the control plane was
 * ASKED to do, so a container that crash-loops right after a successful deploy
 * leaves the row saying "active" — and the UI said "Online" while docker was
 * restarting the container every 60 seconds.
 */

test("a crash-looping container is Restarting, never Online", () => {
  assert.equal(
    displayStatus("active", runtime({ total: 1, running: 0, restarting: 1 })),
    "restarting",
  );
});

test("deployed and up: Online", () => {
  assert.equal(displayStatus("active", runtime()), "active");
});

test("deployed with nothing running is not-running, not Online", () => {
  assert.equal(
    displayStatus("active", runtime({ total: 1, running: 0 })),
    "down",
  );
});

test("the stack vanished from the host: not-running", () => {
  assert.equal(displayStatus("active", runtime({ total: 0, running: 0 })), "down");
});

test("half a compose stack up: degraded", () => {
  assert.equal(
    displayStatus("active", runtime({ total: 3, running: 2 })),
    "degraded",
  );
});

test("a restarting container in a stack outranks the healthy sidecars", () => {
  assert.equal(
    displayStatus("active", runtime({ total: 3, running: 2, restarting: 1 })),
    "restarting",
  );
});

test("a stack whose main container is GONE is degraded, not Online", () => {
  // The trap: every container that still exists is running (the sidecars), and
  // the broken one was removed, so it cannot be counted as not-running. Only the
  // declared-vs-present comparison catches it.
  assert.equal(
    displayStatus(
      "active",
      runtime({ total: 2, running: 2, missing: ["activepieces"] }),
    ),
    "degraded",
  );
});

test("running but failing its own healthcheck is not Online", () => {
  assert.equal(
    displayStatus("active", runtime({ total: 1, running: 1, unhealthy: 1 })),
    "unhealthy",
  );
});

test("a crash loop outranks an unhealthy sidecar", () => {
  assert.equal(
    displayStatus(
      "active",
      runtime({ total: 2, running: 1, restarting: 1, unhealthy: 1 }),
    ),
    "restarting",
  );
});

test("an unreachable agent proves nothing: keep the stored status", () => {
  // Inventing "down" from a dead agent would just be a different lie.
  assert.equal(
    displayStatus("active", runtime({ total: 0, running: 0, unreachable: true })),
    "active",
  );
});

test("no probe yet: keep the stored status", () => {
  assert.equal(displayStatus("active", null), "active");
  assert.equal(displayStatus("active", undefined), "active");
});

test("statuses the host cannot contradict pass through untouched", () => {
  // A build has no container yet; a stopped app is meant to have none; a failed
  // deploy already says so. Only "active" is a claim about the host.
  const none = runtime({ total: 0, running: 0 });
  assert.equal(displayStatus("building", none), "building");
  assert.equal(displayStatus("queued", none), "queued");
  assert.equal(displayStatus("idle", none), "idle");
  assert.equal(displayStatus("stopping", none), "stopping");
  assert.equal(displayStatus("error", none), "error");
});
