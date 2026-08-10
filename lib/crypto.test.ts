import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, scryptSync } from "node:crypto";

import {
  decryptSecret,
  decryptSecretOrThrow,
  encryptSecret,
  hashPassword,
  htpasswdLine,
  passwordNeedsRehash,
  tryDecryptSecret,
  verifyPassword,
} from "./crypto";

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

/* ------------------------------------------------------------------ */
/* Password hashing: the stored work factor, and upgrading past it      */
/* ------------------------------------------------------------------ */

/**
 * The point of these is the MIGRATION, not the algorithm. The original format
 * (`scrypt$<salt>$<hash>`) recorded no cost, so verification had to assume
 * node's defaults forever and the work factor could never be raised without
 * invalidating every account at once. The current format carries `N`, `r` and
 * `p`, and the rule that makes it usable is that both shapes keep verifying -
 * anything less is a mass password reset dressed up as a security improvement.
 *
 * The legacy sample below is built the way the old `hashPassword` built it,
 * from node's own defaults, rather than being pasted in: a hardcoded digest
 * would still pass if the parser silently stopped honouring the legacy
 * parameters and started deriving with the new ones.
 */
const legacyHash = (password: string, salt: Buffer) =>
  `scrypt$${salt.toString("hex")}$${scryptSync(password, salt, 64).toString("hex")}`;

test("hashPassword: the stored form carries its own scrypt parameters", async () => {
  const stored = await hashPassword("correct horse battery staple");
  const parts = stored.split("$");
  assert.equal(parts.length, 6, "scheme, N, r, p, salt, hash");
  assert.equal(parts[0], "scrypt");
  // Whatever the current cost is, it must be a number the verifier can read
  // back - and stronger than what node would have defaulted to.
  assert.ok(Number(parts[1]) > 16384, `N=${parts[1]} must beat the old default`);
  assert.ok(Number(parts[2]) >= 8);
  assert.ok(Number(parts[3]) >= 1);
});

test("verifyPassword: accepts the right password and refuses the wrong one", async () => {
  const stored = await hashPassword("hunter2");
  assert.equal(await verifyPassword("hunter2", stored), true);
  assert.equal(await verifyPassword("hunter3", stored), false);
  assert.equal(await verifyPassword("", stored), false);
});

test("verifyPassword: a hash written in the LEGACY format still verifies", async () => {
  const salt = randomBytes(16);
  const stored = legacyHash("hunter2", salt);
  assert.equal(stored.split("$").length, 3, "the sample really is the old shape");
  assert.equal(await verifyPassword("hunter2", stored), true);
  assert.equal(await verifyPassword("hunter3", stored), false);
});

test("verifyPassword: garbage is refused, never thrown", async () => {
  for (const junk of ["", "scrypt", "bcrypt$x$y", "scrypt$$", "scrypt$a$b$c$d$e$f"])
    assert.equal(await verifyPassword("hunter2", junk), false, junk);
});

test("passwordNeedsRehash: true for a legacy hash, false for a fresh one", async () => {
  assert.equal(passwordNeedsRehash(legacyHash("hunter2", randomBytes(16))), true);
  assert.equal(passwordNeedsRehash(await hashPassword("hunter2")), false);
});

test("passwordNeedsRehash: never downgrades a hash stronger than the current cost", () => {
  // What an OLDER binary must do when it meets a hash a NEWER one wrote: leave
  // it alone. Comparing the tuple field-by-field would get this wrong the first
  // time anybody tunes r instead of N.
  const stronger = `scrypt$1048576$8$1$${"ab".repeat(16)}$${"cd".repeat(32)}`;
  assert.equal(passwordNeedsRehash(stronger), false);
});

test("passwordNeedsRehash: an unparseable hash is not a rehash candidate", () => {
  // It cannot be verified either, so there is no login for the upgrade to ride
  // on - saying "true" here would only invite a caller to rewrite a row it
  // never authenticated.
  assert.equal(passwordNeedsRehash("not-a-hash"), false);
});

test("hashPassword: the same password twice gives different stored values", async () => {
  assert.notEqual(await hashPassword("samepass"), await hashPassword("samepass"));
});

/* ------------------------------------------------------------------ */
/* Stored secrets: telling "empty" apart from "unreadable"              */
/* ------------------------------------------------------------------ */

/**
 * `decryptSecret` answers `""` for both "the stored secret IS empty" and "this
 * ciphertext will not open", and every caller that acted on the difference read
 * the second as the first - an app deployed with a blank API key, a destination
 * that looked unconfigured, a restore that would have treated an encrypted
 * artifact as plaintext. `tryDecryptSecret` is the seam that separates them, so
 * the tests that matter are the two that used to be indistinguishable.
 *
 * The unreadable sample is produced by ROTATING `DEPLO_SECRET` between encrypt
 * and decrypt rather than by corrupting bytes by hand: that is the actual way
 * this happens in production, and `deriveKey` caches per root secret precisely
 * so the swap derives fresh material instead of serving the old key.
 */
function underSecret<T>(secret: string, fn: () => T): T {
  const before = process.env.DEPLO_SECRET;
  process.env.DEPLO_SECRET = secret;
  try {
    return fn();
  } finally {
    if (before === undefined) delete process.env.DEPLO_SECRET;
    else process.env.DEPLO_SECRET = before;
  }
}

test("tryDecryptSecret: a round trip reports ok with the original value", () => {
  const sealed = underSecret("secret-one-aaaaaaaaaaaaaaaa", () =>
    encryptSecret("hunter2"),
  );
  const got = underSecret("secret-one-aaaaaaaaaaaaaaaa", () =>
    tryDecryptSecret(sealed),
  );
  assert.deepEqual(got, { ok: true, value: "hunter2" });
});

test("tryDecryptSecret: an EMPTY secret is ok, not a failure", () => {
  // The case no heuristic can recover: a legitimately blank variable has a
  // perfectly valid ciphertext, so "plaintext is empty" cannot mean "broken".
  const sealed = underSecret("secret-one-aaaaaaaaaaaaaaaa", () => encryptSecret(""));
  const got = underSecret("secret-one-aaaaaaaaaaaaaaaa", () =>
    tryDecryptSecret(sealed),
  );
  assert.deepEqual(got, { ok: true, value: "" });
});

test("tryDecryptSecret: a ciphertext from another DEPLO_SECRET is not ok", () => {
  const sealed = underSecret("secret-one-aaaaaaaaaaaaaaaa", () =>
    encryptSecret("hunter2"),
  );
  const got = underSecret("secret-two-bbbbbbbbbbbbbbbb", () =>
    tryDecryptSecret(sealed),
  );
  assert.deepEqual(got, { ok: false });
});

test("tryDecryptSecret: junk is not ok, and never throws", () => {
  for (const junk of ["", "v1", "v2.a.b.c", "v1.!!.!!.!!", "not-a-payload"])
    assert.deepEqual(tryDecryptSecret(junk), { ok: false }, junk);
});

test("decryptSecret keeps its lossy contract for the best-effort callers", () => {
  const sealed = underSecret("secret-one-aaaaaaaaaaaaaaaa", () =>
    encryptSecret("hunter2"),
  );
  assert.equal(
    underSecret("secret-two-bbbbbbbbbbbbbbbb", () => decryptSecret(sealed)),
    "",
  );
});

test("decryptSecretOrThrow: names the value and blames the right cause", () => {
  const sealed = underSecret("secret-one-aaaaaaaaaaaaaaaa", () =>
    encryptSecret("hunter2"),
  );
  assert.throws(
    () =>
      underSecret("secret-two-bbbbbbbbbbbbbbbb", () =>
        decryptSecretOrThrow(sealed, "The variable DATABASE_URL"),
      ),
    /The variable DATABASE_URL could not be decrypted[\s\S]*different DEPLO_SECRET/,
  );
});

test("decryptSecretOrThrow: an empty stored value is returned, not thrown", () => {
  // Otherwise the strict variant would be unusable at the deploy edge, where a
  // blank variable is an ordinary thing for someone to have set.
  const sealed = underSecret("secret-one-aaaaaaaaaaaaaaaa", () => encryptSecret(""));
  assert.equal(
    underSecret("secret-one-aaaaaaaaaaaaaaaa", () =>
      decryptSecretOrThrow(sealed, "The variable EMPTY_ONE"),
    ),
    "",
  );
});
