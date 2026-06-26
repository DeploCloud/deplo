import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { htpasswdLine } from "./crypto";

/**
 * `htpasswdLine` produces a Traefik-compatible `user:$apr1$salt$hash` credential.
 * The hash is the Apache MD5 (apr1) scheme; we re-derive it here from the salt
 * the helper chose and assert equality, so the test is self-contained (no
 * openssl/passlib dependency) yet still validates the algorithm — not just the
 * shape. The apr1 algorithm itself was cross-checked against `openssl passwd
 * -apr1` during development.
 */

/** A standalone, reference apr1 implementation to verify the helper's output. */
function refApr1(password: string, salt: string): string {
  const magic = "$apr1$";
  const pw = Buffer.from(password, "utf8");
  const saltBuf = Buffer.from(salt, "utf8");
  const md5 = (b: Buffer) => createHash("md5").update(b).digest();
  let ctx = Buffer.concat([pw, Buffer.from(magic), saltBuf]);
  const inner = md5(Buffer.concat([pw, saltBuf, pw]));
  for (let i = pw.length; i > 0; i -= 16)
    ctx = Buffer.concat([ctx, inner.subarray(0, Math.min(16, i))]);
  for (let i = pw.length; i > 0; i >>= 1)
    ctx = Buffer.concat([ctx, (i & 1) === 1 ? Buffer.from([0]) : pw.subarray(0, 1)]);
  let result = md5(ctx);
  for (let i = 0; i < 1000; i++) {
    let round = Buffer.alloc(0);
    round = Buffer.concat([round, (i & 1) === 1 ? pw : result.subarray(0, 16)]);
    if (i % 3 !== 0) round = Buffer.concat([round, saltBuf]);
    if (i % 7 !== 0) round = Buffer.concat([round, pw]);
    round = Buffer.concat([round, (i & 1) === 1 ? result.subarray(0, 16) : pw]);
    result = md5(round);
  }
  const itoa64 = "./0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  const to64 = (value: number, n: number) => {
    let v = value, s = "";
    for (let i = 0; i < n; i++) { s += itoa64[v & 0x3f]; v >>= 6; }
    return s;
  };
  let out = "";
  out += to64((result[0] << 16) | (result[6] << 8) | result[12], 4);
  out += to64((result[1] << 16) | (result[7] << 8) | result[13], 4);
  out += to64((result[2] << 16) | (result[8] << 8) | result[14], 4);
  out += to64((result[3] << 16) | (result[9] << 8) | result[15], 4);
  out += to64((result[4] << 16) | (result[10] << 8) | result[5], 4);
  out += to64(result[11], 2);
  return `${magic}${salt}$${out}`;
}

test("htpasswdLine: shape is user:$apr1$<salt>$<hash>", () => {
  const line = htpasswdLine("alice", "s3cret");
  const m = line.match(/^alice:\$apr1\$([./0-9A-Za-z]{8})\$([./0-9A-Za-z]{22})$/);
  assert.ok(m, `unexpected htpasswd shape: ${line}`);
});

test("htpasswdLine: the hash verifies against an independent apr1 reference", () => {
  const line = htpasswdLine("bob", "hunter2");
  const [user, hash] = line.split(":");
  assert.equal(user, "bob");
  const salt = hash.split("$")[2];
  assert.equal(hash, refApr1("hunter2", salt));
});

test("htpasswdLine: distinct salts per call (probabilistically) ⇒ distinct hashes", () => {
  const a = htpasswdLine("u", "samepass").split(":")[1];
  const b = htpasswdLine("u", "samepass").split(":")[1];
  assert.notEqual(a, b);
});

test("htpasswdLine: username is preserved verbatim", () => {
  assert.ok(htpasswdLine("Admin_1", "x").startsWith("Admin_1:$apr1$"));
});
