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

test("a dependency's short interval is kept through its start period", () => {
  const hc = healthOf(
    `      test: ["CMD", "test", "-f", "/tmp/ok"]
      interval: 3s
      start_period: 15m`,
    "29.9.2",
  );
  assert.equal(hc.start_interval, "3s");
  assert.equal(hc.interval, "3s");
  assert.equal(hc.start_period, "15m");
});

test("sub-second and compound intervals count as short", () => {
  for (const interval of ["500ms", "1s500ms", "4.5s"])
    assert.equal(
      healthOf(`      interval: ${interval}\n      start_period: 1m`, "25.0.0")
        .start_interval,
      interval,
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

test("a healthcheck Docker already probes at least as often is left alone", () => {
  for (const hc of [
    "      interval: 5s\n      start_period: 1m",
    "      interval: 1m\n      start_period: 1m",
    "      start_period: 1m",
    "      interval: 3s",
    "      interval: soon\n      start_period: 1m",
    "      interval: 3s\n      start_period: 1m\n      disable: true",
  ])
    assert.equal(healthOf(hc, "29.9.2").start_interval, undefined, hc);
});

test("the stack's own start_interval wins", () => {
  assert.equal(
    healthOf(
      "      interval: 3s\n      start_period: 1m\n      start_interval: 2s",
      "29.9.2",
    ).start_interval,
    "2s",
  );
});
