import { test } from "node:test";
import assert from "node:assert/strict";

import { screenOrder } from "./use-card-selection";

test("a shift range follows the rows as shown, not the list they came from", () => {
  assert.deepEqual(screenOrder(["a", "b", "c", "d"], ["c", "a", "d", "b"]), [
    "c",
    "a",
    "d",
    "b",
  ]);
});

test("a row not on screen keeps its place after the shown ones; strangers and repeats are ignored", () => {
  assert.deepEqual(screenOrder(["a", "b", "c"], ["x", "b", "b", "a"]), [
    "b",
    "a",
    "c",
  ]);
});
