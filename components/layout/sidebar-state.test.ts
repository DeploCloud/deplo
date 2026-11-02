import test from "node:test";
import assert from "node:assert/strict";
import { nextMode, parseMode, resizeStep } from "./sidebar-state";

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

test("a stored mode is read back, the old collapse flag means hidden", () => {
  assert.equal(parseMode("rail"), "rail");
  assert.equal(parseMode("hidden"), "hidden");
  assert.equal(parseMode("1"), "hidden");
  assert.equal(parseMode("0"), "expanded");
  assert.equal(parseMode(null), "expanded");
});

test("the toggle swaps expanded and the rail, and always leaves hidden", () => {
  assert.equal(nextMode("expanded"), "rail");
  assert.equal(nextMode("rail"), "expanded");
  assert.equal(nextMode("hidden"), "expanded");
});
