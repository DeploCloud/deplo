import test from "node:test";
import assert from "node:assert/strict";
import { nextMode, parseMode, resizeStep } from "./sidebar-state";

test("past the floor the sidebar resizes", () => {
  assert.deepEqual(resizeStep(320), { mode: "expanded", width: 320, peek: 0 });
  assert.equal(resizeStep(900).width, 420);
});

test("under the floor it follows the pointer instead of shrinking", () => {
  assert.deepEqual(resizeStep(200), { mode: "expanded", width: 240, peek: 40 });
});

test("closer to the rail than the floor, the drag snaps into the rail", () => {
  assert.equal(resizeStep(148).mode, "expanded");
  assert.equal(resizeStep(147).mode, "rail");
  assert.deepEqual(resizeStep(-50), { mode: "rail", width: 240, peek: 0 });
});

test("a stored mode is read back, the old hidden sidebar becomes the rail", () => {
  assert.equal(parseMode("rail"), "rail");
  assert.equal(parseMode("hidden"), "rail");
  assert.equal(parseMode("1"), "rail");
  assert.equal(parseMode("0"), "expanded");
  assert.equal(parseMode(null), "expanded");
});

test("the toggle swaps expanded and the rail", () => {
  assert.equal(nextMode("expanded"), "rail");
  assert.equal(nextMode("rail"), "expanded");
});
