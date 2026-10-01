import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { promisify } from "node:util";

import "./scrypt-memo.cjs";
import { hashPassword, verifyPassword } from "../crypto";

const OPTS = { N: 1024, r: 8, p: 1 };

test("a repeat gives back the same bytes, and they are the caller's to keep", async () => {
  const run = promisify(crypto.scrypt) as (
    ...a: [string, string, number, crypto.ScryptOptions]
  ) => Promise<Buffer>;
  const first = await run("pw", "salt", 32, OPTS);
  const again = await run("pw", "salt", 32, OPTS);
  assert.deepEqual(again, first);
  again.fill(0);
  assert.deepEqual(crypto.scryptSync("pw", "salt", 32, OPTS), first);
  assert.notDeepEqual(await run("pw", "pepper", 32, OPTS), first);
  assert.notDeepEqual(await run("pw", "salt", 32, { ...OPTS, N: 2048 }), first);
});

test("a password still verifies, and a wrong one still does not", async () => {
  const stored = await hashPassword("password1");
  assert.equal(await verifyPassword("password1", stored), true);
  assert.equal(await verifyPassword("password1", stored), true);
  assert.equal(await verifyPassword("password2", stored), false);
});
