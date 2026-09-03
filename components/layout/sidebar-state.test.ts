import test from "node:test";
import assert from "node:assert/strict";
import { resizeStep } from "./sidebar-state";

test("past the floor the sidebar resizes", () => {
  assert.deepEqual(resizeStep(320), { width: 320, peek: 0, close: false });
  assert.equal(resizeStep(900).width, 420);
});

test("under the floor it slides out instead of shrinking", () => {
  const step = resizeStep(200);
  assert.equal(step.width, 240);
  assert.equal(step.peek, 40);
  assert.equal(step.close, false);
});

test("nearly hidden snaps shut", () => {
  assert.equal(resizeStep(80).close, true);
  assert.equal(resizeStep(-50).close, true);
});
