import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeUsername,
  validateUsername,
  uniqueUsername,
} from "./username";

test("normalizeUsername lowercases and strips to the allowed charset", () => {
  assert.equal(normalizeUsername("Ada Lovelace"), "ada-lovelace");
  assert.equal(normalizeUsername("  Jane@Doe!  "), "jane-doe");
  assert.equal(normalizeUsername("keep_me-99"), "keep_me-99");
});

test("validateUsername enforces length and charset", () => {
  assert.equal(validateUsername("ada"), null);
  assert.equal(validateUsername("a_b-9"), null);
  assert.ok(validateUsername("ab")); // too short
  assert.ok(validateUsername("a".repeat(33))); // too long
  assert.ok(validateUsername("Ada")); // uppercase not allowed (post-normalize)
});

test("uniqueUsername suffixes on collision", () => {
  const taken = new Set(["ada", "ada-2"]);
  assert.equal(uniqueUsername("ada", taken), "ada-3");
  assert.equal(uniqueUsername("brandnew", taken), "brandnew");
});

test("uniqueUsername backfills a usable handle from a sparse seed", () => {
  const handle = uniqueUsername("@@", new Set());
  assert.ok(handle.length >= 3);
  assert.equal(validateUsername(handle), null);
});
