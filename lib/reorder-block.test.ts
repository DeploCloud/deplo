import { test } from "node:test";
import assert from "node:assert/strict";
import { arrayMove } from "@dnd-kit/sortable";
import { reorderBlock } from "./reorder-block";

const order = ["a", "b", "c", "d", "e"];

test("a lone card behaves exactly like arrayMove, both directions", () => {
  assert.deepEqual(reorderBlock(order, "a", "c"), arrayMove(order, 0, 2));
  assert.deepEqual(reorderBlock(order, "e", "b"), arrayMove(order, 4, 1));
});

test("a selection moves as one block, keeping its relative order", () => {
  assert.deepEqual(reorderBlock(order, "a", "d", ["a", "c"]), [
    "b",
    "d",
    "a",
    "c",
    "e",
  ]);
  // Upward: the block lands before the target.
  assert.deepEqual(reorderBlock(order, "e", "b", ["c", "e"]), [
    "a",
    "c",
    "e",
    "b",
    "d",
  ]);
});

test("dropping onto a member of the block is a no-op", () => {
  assert.equal(reorderBlock(order, "a", "c", ["a", "c"]), null);
});

test("a card outside the selection drags alone", () => {
  assert.deepEqual(
    reorderBlock(order, "b", "d", ["a", "c"]),
    arrayMove(order, 1, 3),
  );
});

test("unknown ids never scramble the order", () => {
  assert.equal(reorderBlock(order, "a", "zz"), null);
  assert.equal(reorderBlock(order, "zz", "a"), null);
});
