import { test } from "node:test";
import assert from "node:assert/strict";

import yaml from "../yaml";
import {
  HEALTH_CHECK_DEFAULTS,
  healthCheckToComposeKeys,
  renderHealthCheckYaml,
} from "./health-check";
import type { HealthCheck } from "../types";

/**
 * The block Deplo writes into an app's compose. Only a COMMAND check renders one:
 * an http check is asked from the agent instead (`lib/apps/http-health.ts`).
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
  assert.deepEqual(healthCheckToComposeKeys(null), {});
  assert.equal(renderHealthCheckYaml(null, 4), "");
});

// The whole reason the http probe moved out of the stack: a `healthcheck:` runs
// inside the image, and a Railpack build, a distroless image or `traefik/whoami`
// has neither curl nor wget - so the container sat unhealthy and Traefik, which
// drops an unhealthy container, took the app off the internet.
test("an http check renders NO healthcheck - Deplo asks the app itself", () => {
  assert.deepEqual(healthCheckToComposeKeys(HTTP), {});
  assert.equal(renderHealthCheckYaml(HTTP, 4), "");
});

test("the times come out as compose durations", () => {
  const keys = healthCheckToComposeKeys({
    ...HTTP,
    type: "command",
    command: "true",
  }) as {
    healthcheck: Record<string, unknown>;
  };
  assert.equal(keys.healthcheck.interval, "30s");
  assert.equal(keys.healthcheck.timeout, "5s");
  assert.equal(keys.healthcheck.retries, 3);
  assert.equal(keys.healthcheck.start_period, "10s");
});

test("a command check runs through a shell, verbatim", () => {
  const keys = healthCheckToComposeKeys({
    ...HTTP,
    type: "command",
    path: null,
    command: "pg_isready -U app || exit 1",
  }) as { healthcheck: { test: string[] } };
  assert.deepEqual(keys.healthcheck.test, [
    "CMD-SHELL",
    "pg_isready -U app || exit 1",
  ]);
});

// A command check with nothing to run would sit unhealthy forever; nothing is
// better than a check that cannot pass.
test("a command check with no command renders nothing", () => {
  assert.deepEqual(
    healthCheckToComposeKeys({ ...HTTP, type: "command", command: "  " }),
    {},
  );
});

test("the fragment lands at the service indent and parses", () => {
  const frag = renderHealthCheckYaml(
    { ...HTTP, type: "command", command: "true" },
    4,
  );
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
