import test from "node:test";
import assert from "node:assert/strict";

import { stepsFor } from "./steps";

const ids = (canInvite: boolean, canTakeOver: boolean) =>
  stepsFor(canInvite, canTakeOver).map((s) => s.id);

test("the plain migration ends on the report", () => {
  assert.deepEqual(ids(true, false), [
    "connect",
    "install",
    "review",
    "people",
    "done",
  ]);
});

// Both of People's actions are instance-admin gated, so for anyone else the step
// would be a page of nothing.
test("People is an instance admin's step", () => {
  assert.deepEqual(ids(false, false), ["connect", "install", "review", "done"]);
});

// Taking the ports is a step of its own, and the LAST one: before the migration
// has finished there is nothing for it to do.
test("a takeover carries one more step, at the end", () => {
  assert.deepEqual(ids(true, true), [
    "connect",
    "install",
    "review",
    "people",
    "done",
    "takeover",
  ]);
  assert.equal(ids(false, true).at(-1), "takeover");
});

test("every step is labelled", () => {
  for (const s of stepsFor(true, true)) {
    assert.ok(s.label.length > 0, `${s.id} has no label`);
  }
  assert.equal(
    stepsFor(true, true).find((s) => s.id === "takeover")?.label,
    "Take over",
  );
});
