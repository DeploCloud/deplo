import { test } from "node:test";
import assert from "node:assert/strict";

import { normalizeRel } from "./app-files";

/**
 * The stack's decrypted env-file sits at the root of the Files tree; the editor,
 * gated one capability below a reveal, must not open it.
 */
test("the .env at the root of the Files tree is off limits to the editor", () => {
  assert.throws(() => normalizeRel(".env"), /Settings → Environment/);
  assert.throws(() => normalizeRel("/.env"), /Settings → Environment/);
  assert.throws(() => normalizeRel("./.env"), /Settings → Environment/);
  assert.throws(() => normalizeRel(".env/."), /Settings → Environment/);
  assert.throws(() => normalizeRel("./.env/./"), /Settings → Environment/);
  assert.equal(normalizeRel("conf/./app.conf"), "conf/app.conf");
  // A file of that name INSIDE a folder is the app's own.
  assert.equal(normalizeRel("config/.env"), "config/.env");
  assert.equal(normalizeRel(".env.example"), ".env.example");
});
