import { test } from "node:test";
import assert from "node:assert/strict";

import { sweepStale } from "./stale-sweep";

test("a small map is left alone, a large one drops only stale entries", () => {
  const m = new Map<string, number>();
  for (let i = 0; i < 10; i++) m.set(`old_${i}`, 0);
  sweepStale(m, (t) => t, 1_000, 5_000);
  assert.equal(m.size, 10, "under the threshold nothing is swept");

  for (let i = 0; i < 300; i++) m.set(`new_${i}`, 4_500);
  sweepStale(m, (t) => t, 1_000, 5_000);
  assert.equal(m.size, 300);
  assert.ok([...m.keys()].every((k) => k.startsWith("new_")));
});
