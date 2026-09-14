import { test } from "node:test";
import assert from "node:assert/strict";

import { fmtCoresUsed } from "./container-monitoring-dashboard";

test("above 100% the caption reads the percentage in cores", () => {
  assert.equal(fmtCoresUsed(299, 8), "2.99 of 8 cores");
  assert.equal(fmtCoresUsed(100, 8), "1.00 of 8 cores");
  assert.equal(fmtCoresUsed(150, 1), "1.50 of 1 core");
});

// Caught on the real page: three apps in a row read "0.00 of 8 cores", which explains nothing.
test("below 100% the percentage explains itself, so there is no caption", () => {
  assert.equal(fmtCoresUsed(0.9, 8), null);
  assert.equal(fmtCoresUsed(0, 8), null);
  assert.equal(fmtCoresUsed(99.9, 8), null);
});

test("an unknown core count never invents one", () => {
  assert.equal(fmtCoresUsed(299, 0), null);
});
