import { test } from "node:test";
import assert from "node:assert/strict";

import { fitting } from "./one-row";

test("all items stay when they fit, with no room kept for a chip that is not needed", () => {
  assert.equal(fitting(300, [100, 100, 90], 5, 30), 3);
});

test("the ones that do not fit leave room for the +N chip", () => {
  // 100 + 5 + 100 = 205, plus 5 + 30 for the chip = 240 > 220: only one stays.
  assert.equal(fitting(220, [100, 100, 100], 5, 30), 1);
  assert.equal(fitting(250, [100, 100, 100], 5, 30), 2);
});

test("a row too narrow for anything keeps only the chip", () => {
  assert.equal(fitting(40, [100, 100], 5, 30), 0);
  assert.equal(fitting(0, [], 5, 30), 0);
});
