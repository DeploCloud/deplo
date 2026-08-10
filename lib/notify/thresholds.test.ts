import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  CLEAR_PCT,
  SUSTAIN_MS,
  evaluateThresholds,
  __resetThresholds,
} from "./thresholds";
import type { ServerMetrics } from "../data/monitoring";

/**
 * The resource detector, evaluated without a dispatcher.
 *
 * Three properties, and all three are the difference between an alert somebody
 * acts on and one they mute: it waits out a spike, it does not flap around the
 * limit, and it never claims a recovery from something it never reported.
 */

beforeEach(() => __resetThresholds());

function sample(over: Partial<ServerMetrics> = {}): ServerMetrics {
  return {
    serverId: "srv_1",
    online: true,
    traefik: true,
    cpu: 10,
    cpuCores: 4,
    memUsed: 1,
    memTotal: 10,
    memPct: 10,
    diskUsed: 1,
    diskTotal: 10,
    diskPct: 10,
    netRx: 0,
    netTx: 0,
    load: [0, 0, 0],
    uptimeSec: 100,
    containers: 3,
    agentVersion: "1.0.0",
    expectedAgentVersion: "1.0.0",
    ts: 0,
    ...over,
  } as ServerMetrics;
}

const evaluate = (m: ServerMetrics, now: number) =>
  evaluateThresholds("srv_1", "eu-main-1", m, now);

test("a healthy server says nothing at all", () => {
  assert.deepEqual(evaluate(sample(), 0), []);
});

test("a spike shorter than the sustain window is not an alert", () => {
  assert.deepEqual(evaluate(sample({ cpu: 97 }), 0), []);
  assert.deepEqual(evaluate(sample({ cpu: 97 }), SUSTAIN_MS - 1), []);
});

test("sustained pressure fires once, naming the metric", () => {
  evaluate(sample({ cpu: 97 }), 0);
  const fired = evaluate(sample({ cpu: 97 }), SUSTAIN_MS + 1);
  assert.equal(fired.length, 1);
  assert.equal(fired[0].key, "server_resources_high");
  assert.equal(fired[0].dedupe.state, "high");
  assert.match(fired[0].title, /CPU at 97%/);
});

test("disk gets its own key, because the answer is different", () => {
  evaluate(sample({ diskPct: 95 }), 0);
  const fired = evaluate(sample({ diskPct: 95 }), SUSTAIN_MS + 1);
  assert.equal(fired[0].key, "server_disk_low");
});

test("a value inside the hysteresis band does not announce a recovery", () => {
  evaluate(sample({ cpu: 91 }), 0);
  evaluate(sample({ cpu: 91 }), SUSTAIN_MS + 1);
  // 89 is under the limit but still inside the band. 91 -> 89 -> 91 must not
  // flap the alert closed and open again; the condition is simply still on.
  assert.deepEqual(evaluate(sample({ cpu: 89 }), SUSTAIN_MS + 2), []);
  const stillHigh = evaluate(sample({ cpu: 91 }), SUSTAIN_MS + 3);
  assert.equal(stillHigh[0]?.dedupe.state, "high");
  // Repeating "high" is what the cooldown throttles into an hourly re-nag
  // (cooldown.test.ts) - what matters here is that it never becomes an "ok".
  assert.equal(
    stillHigh.some((a) => a.dedupe.state === "ok"),
    false,
  );
});

test("falling below the clear band announces the recovery exactly once", () => {
  evaluate(sample({ cpu: 97 }), 0);
  evaluate(sample({ cpu: 97 }), SUSTAIN_MS + 1);
  const recovered = evaluate(sample({ cpu: CLEAR_PCT - 5 }), SUSTAIN_MS + 2);
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].dedupe.state, "ok");
  assert.deepEqual(evaluate(sample({ cpu: 10 }), SUSTAIN_MS + 3), []);
});

test("a server that was never in trouble never reports a recovery", () => {
  // The bug this guards: on the first frame after a restart, every healthy host
  // in the fleet would otherwise announce itself "back to normal".
  assert.deepEqual(evaluate(sample({ cpu: 1, memPct: 1, diskPct: 1 }), 0), []);
});
