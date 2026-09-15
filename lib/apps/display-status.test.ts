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
  assert.equal(
    displayStatus("active", runtime({ total: 0, running: 0 })),
    "down",
  );
});

test("half a compose stack up is still Online", () => {
  assert.equal(
    displayStatus("active", runtime({ total: 3, running: 2 })),
    "active",
  );
});

test("a restarting container in a stack outranks the healthy sidecars", () => {
  assert.equal(
    displayStatus("active", runtime({ total: 3, running: 2, restarting: 1 })),
    "restarting",
  );
});

test("a stack whose main container is GONE still reads Online", () => {
  assert.equal(
    displayStatus(
      "active",
      runtime({ total: 2, running: 2, missing: ["activepieces"] }),
    ),
    "active",
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
  assert.equal(
    displayStatus(
      "active",
      runtime({ total: 0, running: 0, unreachable: true }),
    ),
    "active",
  );
});

test("no probe yet: keep the stored status", () => {
  assert.equal(displayStatus("active", null), "active");
  assert.equal(displayStatus("active", undefined), "active");
});

test("statuses the host cannot contradict pass through untouched", () => {
  const none = runtime({ total: 0, running: 0 });
  assert.equal(displayStatus("building", none), "building");
  assert.equal(displayStatus("queued", none), "queued");
  assert.equal(displayStatus("idle", none), "idle");
  assert.equal(displayStatus("stopping", none), "stopping");
  assert.equal(displayStatus("error", none), "error");
});

test("never deployed reads as such, not as stopped", () => {
  const none = runtime({ total: 0, running: 0 });
  assert.equal(displayStatus("idle", none, true), "not_deployed");
  assert.equal(displayStatus("idle", null, true), "not_deployed");
  assert.equal(displayStatus("idle", none, false), "idle");
  assert.equal(displayStatus("building", none, true), "building");
  assert.equal(displayStatus("error", none, true), "error");
});
