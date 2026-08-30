// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import test from "node:test";
import assert from "node:assert/strict";
import { leavesThisPage } from "./nav-progress";

const here = "https://deplo.test/apps/api/deployments?page=2";

test("a different route starts a navigation", () => {
  assert.equal(leavesThisPage("/apps/api/domains", here), true);
  assert.equal(leavesThisPage("/?project=prc_1", here), true);
  assert.equal(leavesThisPage("https://deplo.test/", here), true);
});

test("the page we are already on never does", () => {
  assert.equal(leavesThisPage(here, here), false);
  assert.equal(leavesThisPage("/apps/api/deployments?page=2", here), false);
  assert.equal(leavesThisPage("#section", here), false);
  assert.equal(leavesThisPage("", here), false);
});

test("another origin never does", () => {
  assert.equal(leavesThisPage("https://deplo.build/docs", here), false);
  assert.equal(leavesThisPage("mailto:admin@acme.com", here), false);
});

test("a query-only change does", () => {
  assert.equal(leavesThisPage("?page=3", here), true);
});
