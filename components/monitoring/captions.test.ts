// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from "node:test";
import assert from "node:assert/strict";

import { fmtCoresUsed } from "./container-monitoring-dashboard";

/**
 * A stack's CPU is a percentage of ONE core, so 299% is three busy cores. The
 * caption exists to say that - and only then.
 */

test("above 100% the caption reads the percentage in cores", () => {
  assert.equal(fmtCoresUsed(299, 8), "2.99 of 8 cores");
  assert.equal(fmtCoresUsed(100, 8), "1.00 of 8 cores");
  assert.equal(fmtCoresUsed(150, 1), "1.50 of 1 core");
});

// Rendering the real page is what caught this: three apps in a row read
// "0.00 of 8 cores", which explains nothing a reader did not already see.
test("below 100% the percentage explains itself, so there is no caption", () => {
  assert.equal(fmtCoresUsed(0.9, 8), null);
  assert.equal(fmtCoresUsed(0, 8), null);
  assert.equal(fmtCoresUsed(99.9, 8), null);
});

test("an unknown core count never invents one", () => {
  assert.equal(fmtCoresUsed(299, 0), null);
});
