import { test } from "node:test";
import assert from "node:assert/strict";

import { clashingKeys } from "./env-parse";

test("only the pasted keys that already exist clash", () => {
  assert.deepEqual(
    clashingKeys(["API_URL", "NEW_ONE", " DB_HOST "], ["DB_HOST", "API_URL"]),
    ["API_URL", "DB_HOST"],
  );
});

test("a key pasted twice is listed once", () => {
  assert.deepEqual(clashingKeys(["A", "A"], ["A"]), ["A"]);
});

test("nothing existing means nothing to confirm", () => {
  assert.deepEqual(clashingKeys(["A", "B"], []), []);
});
