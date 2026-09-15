import { test } from "node:test";
import assert from "node:assert/strict";

import { normalizeRel } from "./app-files";

test("the .env at the root of the Files tree is off limits to the editor", () => {
  assert.throws(() => normalizeRel(".env"), /Settings → Environment/);
  assert.throws(() => normalizeRel("/.env"), /Settings → Environment/);
  assert.throws(() => normalizeRel("./.env"), /Settings → Environment/);
  assert.throws(() => normalizeRel(".env/."), /Settings → Environment/);
  assert.throws(() => normalizeRel("./.env/./"), /Settings → Environment/);
  assert.equal(normalizeRel("conf/./app.conf"), "conf/app.conf");
  assert.equal(normalizeRel("config/.env"), "config/.env");
  assert.equal(normalizeRel(".env.example"), ".env.example");
});
