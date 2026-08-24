import "server-only";

import {
  randomBytes,
  scrypt,
  scryptSync,
  timingSafeEqual,
  createCipheriv,
  createDecipheriv,
  createHmac,
  createHash,
} from "node:crypto";
// Pure JS, no native binding: it has to load on the musl runtime image without a
// rebuild step, which is the same constraint that keeps node-pty and sharp in
// `serverExternalPackages`. Node ships no bcrypt, and Traefik's htpasswd reader
// takes bcrypt, MD5 or SHA1 - so this is the one place a dependency buys a real
// algorithm rather than saving a few lines.
import { hash as bcryptHash } from "bcryptjs";

/**
 * Central secret material.
 * In production set DEPLO_SECRET to a long random string (>= 32 chars).
 * Production refuses to boot without it (mirroring the `DEPLO_DATABASE_URL`
 * guard in lib/db/pg.ts) — silently deriving every key from a public constant
 * would make all secrets, sessions and the agent CA forgeable. A dev/test
 * fallback keeps the app runnable locally.
 */
function rootSecret(): string {
  const s = process.env.DEPLO_SECRET;
  if (s && s.length >= 16) return s;
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "DEPLO_SECRET is required and must be at least 16 characters. Every " +
        "crypto key (secret encryption, sessions, CSRF state, the agent mTLS " +
        "CA) is derived from it; set DEPLO_SECRET to a long random string.",
    );
  }
  return "deplo-dev-insecure-secret-change-me-please-0000";
}

/**
 * Derive a 32-byte key for a given purpose from the root secret.
 *
 * `scryptSync` is a deliberately-slow KDF; deriving the same purpose key on
 * every call dominated hot paths that touch many secrets (e.g. decrypting
 * every env var to render the Variables page). The root secret is fixed for
 * the process lifetime, so the derived key is stable too — memoize per purpose.
 * Keyed by `rootSecret()` as well so a mid-process secret change (tests) still
 * derives fresh material rather than serving a stale key.
 */
const keyCache = new Map<string, Buffer>();
export function deriveKey(purpose: string): Buffer {
  const cacheKey = `${rootSecret()} ${purpose}`;
  let key = keyCache.get(cacheKey);
  if (!key) {
    key = scryptSync(rootSecret(), `deplo:${purpose}`, 32);
    keyCache.set(cacheKey, key);
  }
  return key;
}

/* ------------------------------------------------------------------ */
/* Passwords (scrypt)                                                  */
/* ------------------------------------------------------------------ */

/**
 * The scrypt work factor NEW hashes are made with.
 *
 * Raising these is a one-line change BECAUSE every hash carries the parameters
 * it was produced with (see the format below). The original format did not:
 * `scrypt$<salt>$<hash>` said nothing about cost, so verification had to assume
 * node's defaults forever, and the work factor was frozen at N=16384 for the
 * life of the product - there was no way to strengthen it that did not
 * invalidate every existing password at once.
 *
 * N=65536 rather than the 2^17 OWASP names first, deliberately. Memory is
 * `128 * N * r` ≈ 64 MiB per hash here, against 128 MiB at 2^17, and this runs
 * on whatever box the operator self-hosts on. Async scrypt executes on libuv's
 * threadpool (4 by default), so the real ceiling is ~4 concurrent hashes: 256
 * MiB and ~180ms each at this setting, versus 512 MiB at 2^17. Four times the
 * old cost, bounded memory, and the number is now a knob rather than a
 * one-way door.
 */
const SCRYPT_PARAMS = { N: 65536, r: 8, p: 1 } as const;
/** Node caps scrypt memory at 32 MiB by default, well under `128 * N * r`. */
const SCRYPT_MAXMEM = 512 * 1024 * 1024;
const SCRYPT_KEYLEN = 64;

/** The cost node's `scryptSync(pw, salt, len)` defaults to - what every hash
 *  written before the parameters were recorded was made with. */
const LEGACY_PARAMS = { N: 16384, r: 8, p: 1 } as const;

interface ScryptParams {
  N: number;
  r: number;
  p: number;
}

function scryptAsync(
  password: string,
  salt: Buffer,
  keylen: number,
  params: ScryptParams,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      keylen,
      { ...params, maxmem: SCRYPT_MAXMEM },
      (err, derived) => (err ? reject(err) : resolve(derived)),
    );
  });
}

/**
 * Hash a password: `scrypt$<N>$<r>$<p>$<salt-hex>$<hash-hex>`.
 *
 * Async, not sync, and that is a security property rather than a style
 * preference: `scryptSync` at this cost blocks the event loop for ~180ms per
 * call, so the rate limiter's own allowance (30 login attempts per address per
 * minute) would have been enough to stall the whole control plane. The async
 * form runs on the threadpool, which also bounds how many can be in flight -
 * see {@link SCRYPT_PARAMS}.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scryptAsync(
    password,
    salt,
    SCRYPT_KEYLEN,
    SCRYPT_PARAMS,
  );
  const { N, r, p } = SCRYPT_PARAMS;
  return `scrypt$${N}$${r}$${p}$${salt.toString("hex")}$${derived.toString("hex")}`;
}

/**
 * Split a stored hash into its parameters, salt and digest, accepting BOTH
 * formats. Null when it is neither.
 *
 * The legacy shape has three fields and the current one six, so the field count
 * is the discriminator - no version byte to keep in sync, and no ambiguity: a
 * hex salt can never be mistaken for a decimal cost.
 */
function parseStoredPassword(
  stored: string,
): { params: ScryptParams; salt: Buffer; expected: Buffer } | null {
  const parts = stored.split("$");
  if (parts[0] !== "scrypt") return null;
  if (parts.length === 3)
    return {
      params: LEGACY_PARAMS,
      salt: Buffer.from(parts[1], "hex"),
      expected: Buffer.from(parts[2], "hex"),
    };
  if (parts.length === 6) {
    const [N, r, p] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
    if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p))
      return null;
    return {
      params: { N, r, p },
      salt: Buffer.from(parts[4], "hex"),
      expected: Buffer.from(parts[5], "hex"),
    };
  }
  return null;
}

export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  try {
    const parsed = parseStoredPassword(stored);
    if (!parsed || parsed.expected.length === 0) return false;
    const derived = await scryptAsync(
      password,
      parsed.salt,
      parsed.expected.length,
      parsed.params,
    );
    return timingSafeEqual(derived, parsed.expected);
  } catch {
    return false;
  }
}

/**
 * Whether a stored hash was made with a WEAKER setting than the current one, and
 * should therefore be replaced.
 *
 * Only the caller that just saw the plaintext can act on this - the login path -
 * which is why it is a separate predicate rather than an extra return value on
 * {@link verifyPassword}: everything else that verifies a password (the
 * step-up prompt before a destructive action, the recover script) has no
 * business rewriting the credential.
 *
 * Compares the WORK, not the tuple: `N * r * p` is what an attacker pays, so a
 * hash written at a higher cost by a future release is never downgraded by an
 * older binary that happens to run afterwards.
 */
export function passwordNeedsRehash(stored: string): boolean {
  const parsed = parseStoredPassword(stored);
  if (!parsed) return false;
  const work = (x: ScryptParams) => x.N * x.r * x.p;
  return work(parsed.params) < work(SCRYPT_PARAMS);
}

/**
 * Deterministic 32-byte seed for the agent mTLS CA (PLAN P4 / ADR-0006). The
 * control plane is the CA for the agent PKI; its private key is DERIVED from
 * `DEPLO_SECRET` via this dedicated purpose — one cryptographic source of truth
 * for both secret encryption and the agent PKI, so there is no second critical
 * secret to store or rotate independently. Stable for the process/secret
 * lifetime (memoized in `deriveKey`), so the CA is reconstructed identically on
 * every restart with no stored CA key. **Known debt (P4): rotating
 * `DEPLO_SECRET` re-mints the CA and invalidates every issued agent cert —
 * rotation means re-provisioning every agent.** The seed never leaves the
 * server; only minted certificates (and the agent's leaf key) cross the wire.
 */
export function agentCaSeed(): Buffer {
  return deriveKey("agent-mtls-ca");
}

/* ------------------------------------------------------------------ */
/* htpasswd (bcrypt) for Traefik basicauth                             */
/* ------------------------------------------------------------------ */

/**
 * The bcrypt cost for a basic-auth credential. 10 is ~60ms here, which is the
 * usual ceiling for something derived on every stack render; the credential is
 * also a password a person typed, so the salt is doing most of the work.
 */
const HTPASSWD_COST = 10;

/**
 * Produce a `user:hash` htpasswd line for Traefik's `basicauth` middleware.
 *
 * **bcrypt**, not the Apache MD5 (`$apr1$`) this used to emit. Traefik's
 * `go-htpasswd` accepts bcrypt, MD5 and SHA1, and apr1 is 1000 rounds of MD5 —
 * a few seconds a hash on a GPU. That matters because the hash does not stay
 * in the database: it is written into the proxy's compose file ON THE HOST and,
 * for the panel's own credential, read back into the control plane with the rest
 * of the stack. A credential that leaks with the file should still cost
 * something to break.
 *
 * ASYNC, for the same reason {@link hashPassword} is: this runs on the deploy
 * render path, once per basic-auth user, and a synchronous bcrypt would hold the
 * event loop for the whole stack.
 *
 * The caller is responsible for any compose-level `$`→`$$` escaping — the hash
 * contains literal `$` separators that docker-compose treats as variable
 * interpolation, so a YAML-embedded label must double them. The returned string
 * here is the RAW htpasswd line (single `$`), so it is correct for an env-file /
 * dynamic-config consumer; the renderer escapes it for the label form.
 *
 * Nothing verifies these hashes on this side, so there is no legacy format to
 * keep reading: every one of them is re-derived from the stored plaintext on the
 * next render (apr1 salted randomly per render too), and Traefik verifies both
 * schemes regardless.
 */
export async function htpasswdLine(
  username: string,
  password: string,
): Promise<string> {
  return `${username}:${await bcryptHash(password, HTPASSWD_COST)}`;
}

/* ------------------------------------------------------------------ */
/* Symmetric encryption for stored secrets (AES-256-GCM)              */
/* ------------------------------------------------------------------ */

export function encryptSecret(plaintext: string): string {
  const key = deriveKey("secrets");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString("base64")}.${tag.toString("base64")}.${enc.toString(
    "base64",
  )}`;
}

/**
 * Open a ciphertext, saying WHETHER it opened as well as what came out.
 *
 * The distinction is the whole point. {@link decryptSecret} answers `""` both
 * for "this secret is the empty string" and for "this ciphertext could not be
 * opened", and almost every caller reads that as "nothing is set" - so a
 * `DEPLO_SECRET` that no longer matches degrades into an app deployed with
 * blank credentials, a backup destination that looks unconfigured, and a
 * restore that would try to read an encrypted artifact as plaintext. All of it
 * silent, and none of it distinguishable from the operator simply not having
 * filled the field in.
 *
 * A guess cannot recover the difference either: an empty value has a perfectly
 * valid, non-empty ciphertext, so "plaintext is empty but ciphertext was not"
 * is a heuristic that fires on a legitimately blank environment variable. Only
 * the decrypt itself knows, which is why the answer is reported from here.
 */
export function tryDecryptSecret(
  payload: string,
): { ok: true; value: string } | { ok: false } {
  try {
    const [version, ivB64, tagB64, dataB64] = payload.split(".");
    if (version !== "v1") return { ok: false };
    const key = deriveKey("secrets");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(ivB64, "base64"),
    );
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    const dec = Buffer.concat([
      decipher.update(Buffer.from(dataB64, "base64")),
      decipher.final(),
    ]);
    return { ok: true, value: dec.toString("utf8") };
  } catch {
    return { ok: false };
  }
}

/**
 * Open a ciphertext, or `""` if it will not open.
 *
 * The lossy form, kept because most callers genuinely do want a best-effort
 * read (a masked display, an optional field). Anywhere a wrong answer is
 * ACTED on - credentials handed to an agent, a token sent to a provider, a key
 * that decides whether an artifact is encrypted - use
 * {@link decryptSecretOrThrow} instead, and let the failure be loud.
 */
export function decryptSecret(payload: string): string {
  const res = tryDecryptSecret(payload);
  return res.ok ? res.value : "";
}

/**
 * {@link decryptSecret} for the call sites where `""` is not an answer.
 *
 * `what` names the thing in the operator's language, because there is exactly
 * one cause worth reporting and it is not a bug: the value was sealed under a
 * different `DEPLO_SECRET` than the one this process booted with. There is no
 * key versioning to fall back through, so the honest message says what is
 * unreadable and why, rather than surfacing whatever confusing downstream error
 * an empty credential would have produced three layers later.
 */
export function decryptSecretOrThrow(payload: string, what: string): string {
  const res = tryDecryptSecret(payload);
  if (!res.ok)
    throw new Error(
      `${what} could not be decrypted. It was encrypted with a different ` +
        `DEPLO_SECRET than this instance is running with.`,
    );
  return res.value;
}

/* ------------------------------------------------------------------ */
/* Encoding helpers                                                    */
/* ------------------------------------------------------------------ */

function b64url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function fromB64url(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

/* ------------------------------------------------------------------ */
/* Misc                                                                */
/* ------------------------------------------------------------------ */

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/* ------------------------------------------------------------------ */
/* Stateless signed state (CSRF tokens for external OAuth-style flows) */
/* ------------------------------------------------------------------ */

/**
 * Sign an arbitrary short string into a tamper-proof, expiring token. Used to
 * carry CSRF state through external redirect flows (e.g. the GitHub App
 * manifest callback) without server-side storage.
 */
export function signState(data: string, ttlSeconds = 600): string {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const body = b64url(Buffer.from(JSON.stringify({ d: data, exp }), "utf8"));
  const sig = b64url(
    createHmac("sha256", deriveKey("state")).update(body).digest(),
  );
  return `${body}.${sig}`;
}

/** Verify a token from `signState`; returns the original data or null. */
export function verifyState(token: string | undefined): string | null {
  if (!token) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = b64url(
    createHmac("sha256", deriveKey("state")).update(body).digest(),
  );
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(fromB64url(body).toString("utf8")) as {
      d: string;
      exp: number;
    };
    if (typeof payload.exp !== "number" || payload.exp * 1000 < Date.now())
      return null;
    return payload.d;
  } catch {
    return null;
  }
}

export function randomToken(bytes = 24): string {
  return b64url(randomBytes(bytes));
}

export function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
