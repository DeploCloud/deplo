import { test } from "node:test";
import assert from "node:assert/strict";

import { buildDoc } from "./stack-test-helpers";

const stack = (healthcheck: string) => `
services:
  provision:
    image: alpine
    healthcheck:
${healthcheck}
  web:
    image: nginx
    depends_on:
      provision:
        condition: service_healthy
`;

const healthOf = (healthcheck: string, dockerVersion?: string) =>
  (
    buildDoc(stack(healthcheck), { dockerVersion }).services
      .provision as unknown as { healthcheck: Record<string, unknown> }
  ).healthcheck;

test("a starting dependency is probed every second, then at its own interval", () => {
  const hc = healthOf(
    `      test: ["CMD", "test", "-f", "/tmp/ok"]
      interval: 3s
      start_period: 15m`,
    "29.9.2",
  );
  assert.equal(hc.start_interval, "1s");
  assert.equal(hc.interval, "3s");
  assert.equal(hc.start_period, "15m");
});

test("any start period gets the one-second probe, whatever its interval", () => {
  for (const interval of ["5s", "1m", "1s500ms", "${HC_INTERVAL:-10s}"])
    assert.equal(
      healthOf(`      interval: ${interval}\n      start_period: 1m`, "25.0.0")
        .start_interval,
      "1s",
      interval,
    );
  assert.equal(
    healthOf("      start_period: 30s", "25.0.0").start_interval,
    "1s",
  );
});

test("an interval under a second is kept while starting too", () => {
  assert.equal(
    healthOf("      interval: 500ms\n      start_period: 1m", "29.9.2")
      .start_interval,
    "500ms",
  );
});

test("a Docker older than 25, or one not known yet, gets the stack as written", () => {
  for (const version of ["24.0.7", "", undefined])
    assert.equal(
      healthOf("      interval: 3s\n      start_period: 15m", version)
        .start_interval,
      undefined,
    );
});

test("no start period, a disabled check or the stack's own start_interval stay as written", () => {
  assert.equal(
    healthOf("      interval: 3s", "29.9.2").start_interval,
    undefined,
  );
  assert.equal(
    healthOf(
      "      interval: 3s\n      start_period: 1m\n      disable: true",
      "29.9.2",
    ).start_interval,
    undefined,
  );
  assert.equal(
    healthOf(
      "      interval: 3s\n      start_period: 1m\n      start_interval: 2s",
      "29.9.2",
    ).start_interval,
    "2s",
  );
});
