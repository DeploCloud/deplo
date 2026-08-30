import { test } from "node:test";
import assert from "node:assert/strict";

import {
  EMPTY_HEALTH_CHECK_FORM,
  healthCheckFromForm,
  healthCheckProblem,
  healthCheckToForm,
} from "./health-check-model";
import type { HealthCheck } from "../types";

/** The form's data model: strings in, a check (or nothing) out. */

const SAVED: HealthCheck = {
  type: "http",
  path: "/healthz",
  port: 8080,
  command: null,
  intervalS: 15,
  timeoutS: 3,
  retries: 2,
  startPeriodS: 20,
};

test("no check opens the form on the defaults, switched off", () => {
  const f = healthCheckToForm(null);
  assert.equal(f.enabled, false);
  assert.equal(f.type, "http");
  assert.equal(f.intervalS, "30");
  assert.deepEqual(f, EMPTY_HEALTH_CHECK_FORM);
});

test("a saved check round-trips through the form", () => {
  assert.deepEqual(healthCheckFromForm(healthCheckToForm(SAVED)), SAVED);
});

test("the switch off is the whole answer", () => {
  assert.equal(
    healthCheckFromForm({ ...healthCheckToForm(SAVED), enabled: false }),
    null,
  );
});

test("an empty port means the app's own port", () => {
  const h = healthCheckFromForm({ ...healthCheckToForm(SAVED), port: "  " });
  assert.equal(h?.port, null);
});

test("a blank path is the root", () => {
  const h = healthCheckFromForm({ ...healthCheckToForm(SAVED), path: "" });
  assert.equal(h?.path, "/");
});

test("nonsense in a number field falls back rather than saving NaN", () => {
  const h = healthCheckFromForm({
    ...healthCheckToForm(SAVED),
    intervalS: "banana",
    retries: "2.6",
  });
  assert.equal(h?.intervalS, 30);
  assert.equal(h?.retries, 3);
});

test("the numbers are bounded to something a container can run", () => {
  const h = healthCheckFromForm({
    ...healthCheckToForm(SAVED),
    intervalS: "0",
    timeoutS: "999999",
    retries: "-4",
    startPeriodS: "-1",
  });
  assert.equal(h?.intervalS, 1);
  assert.equal(h?.timeoutS, 3600);
  assert.equal(h?.retries, 1);
  assert.equal(h?.startPeriodS, 0);
});

test("switching to a command drops the http fields, and back again", () => {
  const cmd = healthCheckFromForm({
    ...healthCheckToForm(SAVED),
    type: "command",
    command: "pg_isready",
  });
  assert.deepEqual(
    [cmd?.type, cmd?.path, cmd?.port, cmd?.command],
    ["command", null, null, "pg_isready"],
  );
});

/* ---- what will not save --------------------------------------------- */

test("a command check needs a command", () => {
  assert.match(
    healthCheckProblem({ ...SAVED, type: "command", command: null }) ?? "",
    /Give the command/,
  );
});

test("a path has to be a path", () => {
  assert.match(
    healthCheckProblem({ ...SAVED, path: "healthz" }) ?? "",
    /start with a slash/,
  );
});

// A timeout at or above the interval means one check is still running when the
// next is due, and the container never settles either way.
test("the timeout has to be shorter than the interval", () => {
  assert.match(
    healthCheckProblem({ ...SAVED, intervalS: 5, timeoutS: 5 }) ?? "",
    /shorter than the interval/,
  );
  assert.equal(
    healthCheckProblem({ ...SAVED, intervalS: 5, timeoutS: 4 }),
    null,
  );
});

test("no check is never a problem", () => {
  assert.equal(healthCheckProblem(null), null);
  assert.equal(healthCheckProblem(SAVED), null);
});
