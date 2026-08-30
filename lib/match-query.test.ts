// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from "node:test";
import assert from "node:assert/strict";

import { foldQuery, matchRank, matchesQuery } from "./match-query";

test("folding ignores case and every separator", () => {
  assert.equal(foldQuery("Better-Auth Docs!"), "betterauthdocs");
  assert.equal(foldQuery("   "), "");
  assert.ok(matchesQuery("better auth", "better-auth-docs"));
  assert.ok(!matchesQuery("", "anything"));
});

test("rank orders exact, then prefix, then substring, then nothing", () => {
  assert.equal(matchRank("api", "api"), 0);
  assert.equal(matchRank("api", "api-gateway"), 1);
  assert.equal(matchRank("api", "legacy-api"), 2);
  assert.equal(matchRank("api", "postgres"), 3);
  assert.equal(matchRank("", "api"), 3, "a blank query ranks nothing");
});

test("rank answers with the BEST of the fields it was given", () => {
  // An id that merely contains the needle must not drag down a name that IS it.
  assert.equal(matchRank("api", "prj_capi_1", "api"), 0);
  assert.equal(matchRank("api", "nope", "api-gateway"), 1);
});

test("rank agrees with the gate: 3 exactly when matchesQuery is false", () => {
  for (const [q, f] of [
    ["api", "api"],
    ["api", "legacy-api"],
    ["api", "postgres"],
    ["", "api"],
  ] as const) {
    assert.equal(matchRank(q, f) < 3, matchesQuery(q, f), `${q} / ${f}`);
  }
});

test("an accent folds to the letter under it, not to nothing", () => {
  // A team writing in Italian, French or Spanish names things with accents, and
  // nobody types them into a search box.
  assert.equal(foldQuery("Café"), "cafe");
  assert.equal(foldQuery("Münchén"), "munchen");
  assert.equal(foldQuery("naïve"), "naive");
  assert.ok(matchesQuery("cafe", "Café"), "typed plain, stored accented");
  assert.ok(matchesQuery("café", "Cafe"), "typed accented, stored plain");
  assert.equal(matchRank("cafe", "Café"), 0, "and it still counts as exact");
});
