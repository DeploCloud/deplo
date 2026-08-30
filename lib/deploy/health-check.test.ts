import { test } from "node:test";
import assert from "node:assert/strict";

import yaml from "../yaml";
import {
  HEALTH_CHECK_DEFAULTS,
  healthCheckToComposeKeys,
  httpProbeCommand,
  renderHealthCheckYaml,
} from "./health-check";
import type { HealthCheck } from "../types";

/**
 * The block Deplo writes into an app's compose. Docker runs it INSIDE the
 * container, which is why the http probe has to reach for two clients.
 */

const HTTP: HealthCheck = {
  type: "http",
  path: "/healthz",
  port: null,
  command: null,
  intervalS: 30,
  timeoutS: 5,
  retries: 3,
  startPeriodS: 10,
};

test("an app with no check renders nothing at all", () => {
  assert.deepEqual(healthCheckToComposeKeys(null, 3000), {});
  assert.equal(renderHealthCheckYaml(null, 3000, 4), "");
});

test("an http check reaches for curl, then wget, then gives up", () => {
  const cmd = httpProbeCommand("/healthz", 3000);
  assert.match(cmd, /^curl -fsS/);
  assert.match(cmd, /\|\| wget /);
  assert.match(cmd, /\|\| exit 1$/);
  // 127.0.0.1, not the container's name: the check runs inside the container.
  assert.match(cmd, /http:\/\/127\.0\.0\.1:3000\/healthz/);
});

test("a path without its slash still asks for a path", () => {
  assert.match(httpProbeCommand("healthz", 8080), /:8080\/healthz/);
});

test("an http check falls back to the app's own port", () => {
  const keys = healthCheckToComposeKeys(HTTP, 4321) as {
    healthcheck: { test: string[] };
  };
  assert.match(keys.healthcheck.test[1], /:4321\/healthz/);

  const pinned = healthCheckToComposeKeys({ ...HTTP, port: 9000 }, 4321) as {
    healthcheck: { test: string[] };
  };
  assert.match(pinned.healthcheck.test[1], /:9000\/healthz/);
});

test("the times come out as compose durations", () => {
  const keys = healthCheckToComposeKeys(HTTP, 3000) as {
    healthcheck: Record<string, unknown>;
  };
  assert.equal(keys.healthcheck.interval, "30s");
  assert.equal(keys.healthcheck.timeout, "5s");
  assert.equal(keys.healthcheck.retries, 3);
  assert.equal(keys.healthcheck.start_period, "10s");
});

test("a command check runs through a shell, verbatim", () => {
  const keys = healthCheckToComposeKeys(
    {
      ...HTTP,
      type: "command",
      path: null,
      command: "pg_isready -U app || exit 1",
    },
    3000,
  ) as { healthcheck: { test: string[] } };
  assert.deepEqual(keys.healthcheck.test, [
    "CMD-SHELL",
    "pg_isready -U app || exit 1",
  ]);
});

// A command check with nothing to run would sit unhealthy forever; nothing is
// better than a check that cannot pass.
test("a command check with no command renders nothing", () => {
  assert.deepEqual(
    healthCheckToComposeKeys({ ...HTTP, type: "command", command: "  " }, 3000),
    {},
  );
});

test("the fragment lands at the service indent and parses", () => {
  const frag = renderHealthCheckYaml(HTTP, 3000, 4);
  for (const line of frag.split("\n").filter(Boolean))
    assert.ok(line.startsWith("    "), line);
  const parsed = yaml.load(
    `services:\n  web:\n${frag.replace(/^ {4}/gm, "    ")}`,
  ) as { services: { web: { healthcheck?: unknown } } };
  assert.ok(parsed.services.web.healthcheck);
});

test("the defaults are the ones the form starts from", () => {
  assert.deepEqual(HEALTH_CHECK_DEFAULTS, {
    intervalS: 30,
    timeoutS: 5,
    retries: 3,
    startPeriodS: 10,
  });
});
