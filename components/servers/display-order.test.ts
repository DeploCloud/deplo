import { test } from "node:test";
import assert from "node:assert/strict";

import { byOrder, inDisplayOrder } from "./display-order";

const items = (...ids: string[]) => ids.map((id) => ({ id }));
const ids = (list: { id: string }[]) => list.map((i) => i.id);
const host = (i: { id: string }) => i.id === "host";

test("Deplo's machine leads until someone places it, then sits where it was put", () => {
  const all = items("a", "host", "b");
  assert.deepEqual(ids(inDisplayOrder(all, new Map(), host)), [
    "host",
    "a",
    "b",
  ]);
  const placed = new Map([
    ["b", 0],
    ["host", 1],
    ["a", 2],
  ]);
  assert.deepEqual(ids(inDisplayOrder(all, placed, host)), ["b", "host", "a"]);
});

test("one never placed comes after the placed ones, as it came", () => {
  const placed = new Map([
    ["c", 0],
    ["a", 1],
  ]);
  assert.deepEqual(
    ids(inDisplayOrder(items("new-1", "a", "new-2", "c"), placed)),
    ["c", "a", "new-1", "new-2"],
  );
  assert.deepEqual(ids(byOrder(items("x", "a", "b"), ["b", "a"])), [
    "b",
    "a",
    "x",
  ]);
});
