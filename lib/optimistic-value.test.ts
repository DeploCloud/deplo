// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from "node:test";
import assert from "node:assert/strict";
import { overrideValue, settleOverride } from "./optimistic-value";

test("the override stands while the server still serves the old value", () => {
  const override = { base: "api", value: "api-v2" };
  // The mutation resolved, but the RSC refresh carrying the new name has not.
  const settled = settleOverride(override, "api");
  assert.equal(
    settled,
    override,
    "must return the SAME object - a new one re-renders forever",
  );
  assert.equal(overrideValue(settled, "api"), "api-v2");
});

test("the override retires the moment the server's value moves", () => {
  const override = { base: "api", value: "api-v2" };
  assert.equal(settleOverride(override, "api-v2"), null, "the refresh landed");
  assert.equal(overrideValue(null, "api-v2"), "api-v2");
});

test("someone else's change retires the override too", () => {
  const override = { base: false, value: true };
  // Another tab turned it on and off again while this one was in flight: the
  // served value is no longer the base, so the local guess steps aside.
  assert.equal(settleOverride(override, true), null);
});

test("a change that leaves the served value untouched keeps its override", () => {
  // Renaming something to the name it already had: the mutation succeeds and the
  // refresh brings back the identical value.
  const override = { base: "api", value: "api" };
  assert.equal(settleOverride(override, "api"), override);
});

test("no override means the server's value, always", () => {
  assert.equal(settleOverride(null, "anything"), null);
  assert.equal(overrideValue(null, 7), 7);
});
