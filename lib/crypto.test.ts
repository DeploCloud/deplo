import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, scryptSync } from "node:crypto";
import { compare as bcryptCompare } from "bcryptjs";

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
 * `htpasswdLine` produces a Traefik-compatible `user:$2b$<cost>$<salt+hash>`
 * credential — bcrypt, which Traefik's `go-htpasswd` reads alongside the MD5
 * (apr1) scheme this used to emit.
 */

test("htpasswdLine: shape is user:$2b$<cost>$…", async () => {
  const line = await htpasswdLine("alice", "s3cret");
  const m = line.match(/^alice:(\$2[aby]\$(\d{2})\$[./A-Za-z0-9]{53})$/);
  assert.ok(m, `unexpected htpasswd shape: ${line}`);
  assert.ok(Number(m[2]) >= 10, `bcrypt cost too low: ${m[2]}`);
});

test("htpasswdLine: the hash verifies, and only against the right password", async () => {
  const line = await htpasswdLine("bob", "hunter2");
  const [user, ...rest] = line.split(":");
  const hash = rest.join(":");
  assert.equal(user, "bob");
  assert.equal(await bcryptCompare("hunter2", hash), true);
  assert.equal(await bcryptCompare("hunter3", hash), false);
});

test("htpasswdLine: distinct salts per call (probabilistically) ⇒ distinct hashes", async () => {
  const a = (await htpasswdLine("u", "samepass")).split(":")[1];
  const b = (await htpasswdLine("u", "samepass")).split(":")[1];
  assert.notEqual(a, b);
});

test("htpasswdLine: username is preserved verbatim", async () => {
  assert.ok((await htpasswdLine("Admin_1", "x")).startsWith("Admin_1:$2"));
});

/* ------------------------------------------------------------------ */
/* Password hashing: the stored work factor, and upgrading past it      */
/* ------------------------------------------------------------------ */

/**
 * The point of these is the MIGRATION, not the algorithm.
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
  assert.ok(
    Number(parts[1]) > 16384,
    `N=${parts[1]} must beat the old default`,
  );
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
  assert.equal(
    stored.split("$").length,
    3,
    "the sample really is the old shape",
  );
  assert.equal(await verifyPassword("hunter2", stored), true);
  assert.equal(await verifyPassword("hunter3", stored), false);
});

test("verifyPassword: garbage is refused, never thrown", async () => {
  for (const junk of [
    "",
    "scrypt",
    "bcrypt$x$y",
    "scrypt$$",
    "scrypt$a$b$c$d$e$f",
  ])
    assert.equal(await verifyPassword("hunter2", junk), false, junk);
});

test("passwordNeedsRehash: true for a legacy hash, false for a fresh one", async () => {
  assert.equal(
    passwordNeedsRehash(legacyHash("hunter2", randomBytes(16))),
    true,
  );
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
  assert.notEqual(
    await hashPassword("samepass"),
    await hashPassword("samepass"),
  );
});

/* ------------------------------------------------------------------ */
/* Stored secrets: telling "empty" apart from "unreadable"              */
/* ------------------------------------------------------------------ */

/**
 * `decryptSecret` answers `""` for both "the stored secret IS empty" and "this
 * ciphertext will not open", and every caller that acted on the difference read
 * the second as the first - an app deployed with a blank API key, a destination
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
  const sealed = underSecret("secret-one-aaaaaaaaaaaaaaaa", () =>
    encryptSecret(""),
  );
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
  const sealed = underSecret("secret-one-aaaaaaaaaaaaaaaa", () =>
    encryptSecret(""),
  );
  assert.equal(
    underSecret("secret-one-aaaaaaaaaaaaaaaa", () =>
      decryptSecretOrThrow(sealed, "The variable EMPTY_ONE"),
    ),
    "",
  );
});
