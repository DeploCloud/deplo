import { test } from "node:test";
import assert from "node:assert/strict";

import { RestartRule_Probe } from "../agent/gen/agent";
import type { HealthCheck } from "../types/container";
import { restartRuleFor } from "./restart-rule";

const WITH_DOMAIN = { port: 3000, portRequired: true, service: "" };
const WORKER = { port: 0, portRequired: false, service: "" };

const http: HealthCheck = {
  type: "http",
  path: "/healthz",
  port: 8080,
  command: null,
  intervalS: 15,
  timeoutS: 4,
  retries: 5,
  startPeriodS: 20,
};

test("an app with a domain and no check gets GET / on its port", () => {
  const rule = restartRuleFor({
    enabled: true,
    healthCheck: null,
    ready: WITH_DOMAIN,
  });
  assert.deepEqual(rule, {
    probe: RestartRule_Probe.PROBE_HTTP,
    port: 3000,
    path: "/",
    intervalS: 30,
    timeoutS: 10,
    retries: 3,
    startPeriodS: 60,
    service: "",
    failOnErrorStatus: false,
  });
});

test("the app's own http check replaces the default", () => {
  const rule = restartRuleFor({
    enabled: true,
    healthCheck: http,
    ready: WITH_DOMAIN,
  });
  assert.equal(rule?.probe, RestartRule_Probe.PROBE_HTTP);
  assert.equal(rule?.port, 8080);
  assert.equal(rule?.path, "/healthz");
  assert.equal(rule?.retries, 5);
  assert.equal(rule?.intervalS, 15);
  assert.equal(rule?.startPeriodS, 20);
  // "Alive" means what the owner said: a 503 from their /healthz is a failure.
  assert.equal(rule?.failOnErrorStatus, true);
});

test("an http check with no port of its own uses the routed one", () => {
  const rule = restartRuleFor({
    enabled: true,
    healthCheck: { ...http, port: null },
    ready: WITH_DOMAIN,
  });
  assert.equal(rule?.port, 3000);
});

test("a command check is Docker's own health", () => {
  const rule = restartRuleFor({
    enabled: true,
    healthCheck: {
      ...http,
      type: "command",
      command: "pg_isready",
      path: null,
      port: null,
    },
    ready: WITH_DOMAIN,
  });
  assert.equal(rule?.probe, RestartRule_Probe.PROBE_DOCKER_HEALTH);
  assert.equal(rule?.port, 0);
  assert.equal(rule?.startPeriodS, 20);
});

test("a worker with no domain and no check gets no rule", () => {
  assert.equal(
    restartRuleFor({ enabled: true, healthCheck: null, ready: WORKER }),
    null,
  );
});

test("an http check on a worker with no port has nothing to probe", () => {
  assert.equal(
    restartRuleFor({
      enabled: true,
      healthCheck: { ...http, port: null },
      ready: WORKER,
    }),
    null,
  );
});

test("the switch off means no rule, whatever the check says", () => {
  for (const healthCheck of [null, http])
    assert.equal(
      restartRuleFor({ enabled: false, healthCheck, ready: WITH_DOMAIN }),
      null,
    );
});

test("a stack's rule names the routed service", () => {
  const rule = restartRuleFor({
    enabled: true,
    healthCheck: null,
    ready: { port: 80, portRequired: true, service: "web" },
  });
  assert.equal(rule?.service, "web");
  assert.equal(rule?.port, 80);
});
