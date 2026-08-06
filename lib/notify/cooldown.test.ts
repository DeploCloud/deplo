import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { shouldFire, __resetCooldowns } from "./cooldown";

/**
 * The dedupe state machine, with `now` injected so nothing sleeps.
 *
 * The load-bearing case is the third one: a CHANGE of state always fires, which
 * is what makes "server back online" and "CPU back to normal" come out of the
 * same call the emitters already make on every observation.
 */

beforeEach(() => __resetCooldowns());

test("the first observation always fires", () => {
  assert.equal(shouldFire("server_offline", "server:a", "offline", 0), true);
});

test("the same state inside the cooldown stays quiet", () => {
  shouldFire("server_offline", "server:a", "offline", 0);
  assert.equal(
    shouldFire("server_offline", "server:a", "offline", 60_000),
    false,
  );
});

test("a state CHANGE fires immediately - this is the recovery edge", () => {
  shouldFire("server_offline", "server:a", "offline", 0);
  assert.equal(shouldFire("server_offline", "server:a", "online", 1_000), true);
});

test("the same state fires again once the cooldown has passed", () => {
  shouldFire("server_offline", "server:a", "offline", 0);
  assert.equal(
    shouldFire("server_offline", "server:a", "offline", 31 * 60_000),
    true,
  );
});

test("two subjects do not share a slot", () => {
  shouldFire("server_offline", "server:a", "offline", 0);
  assert.equal(shouldFire("server_offline", "server:b", "offline", 0), true);
});

test("two alert kinds about the same subject do not share a slot", () => {
  shouldFire("server_offline", "server:a", "offline", 0);
  assert.equal(shouldFire("app_crash_loop", "server:a", "offline", 0), true);
});

test("an update nag uses the version as its state, so a new release re-fires", () => {
  assert.equal(
    shouldFire("deplo_update_available", "deplo-update", "1.2.0", 0),
    true,
  );
  // Same version, next day: still quiet (the nag is weekly).
  assert.equal(
    shouldFire("deplo_update_available", "deplo-update", "1.2.0", 86_400_000),
    false,
  );
  // A newer release changes the state and gets through at once.
  assert.equal(
    shouldFire("deplo_update_available", "deplo-update", "1.3.0", 86_400_001),
    true,
  );
});
