import { test } from "node:test";
import assert from "node:assert/strict";

import { clampStep } from "./wizard-step";

const STEPS = ["agent", "permissions", "connect", "done"] as const;
type Step = (typeof STEPS)[number];
const upTo =
  (last: Step) =>
  (s: Step): boolean =>
    STEPS.indexOf(s) <= STEPS.indexOf(last);

test("a step the wizard can show is kept", () => {
  assert.equal(
    clampStep(STEPS, "connect", upTo("connect"), "agent"),
    "connect",
  );
});

test("a step too far falls back to the nearest reachable one before it", () => {
  assert.equal(
    clampStep(STEPS, "done", upTo("permissions"), "agent"),
    "permissions",
  );
});

test("an unknown or unreachable step lands on the fallback", () => {
  assert.equal(clampStep(STEPS, "billing", upTo("done"), "agent"), "agent");
  assert.equal(clampStep(STEPS, null, upTo("done"), "connect"), "connect");
  assert.equal(
    clampStep(STEPS, "done", () => false, "agent"),
    "agent",
  );
});
