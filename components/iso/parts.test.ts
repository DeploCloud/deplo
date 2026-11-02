import { test } from "node:test";
import assert from "node:assert/strict";

import { markAt } from "./parts";

test("markAt puts the mark's middle on the point it is given", () => {
  const size = 0.8;
  const [x, y, z] = markAt([1, 2, 1], size);
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;
  assert.ok(near(x + ((24.583 / 26) * size) / 2, 1), "centred across");
  assert.ok(near(z - ((25.116 / 26) * size) / 2, 1), "centred up and down");
  assert.equal(y, 2, "on the face itself");
});
