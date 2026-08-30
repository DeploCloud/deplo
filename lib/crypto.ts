// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

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
// `serverExternalPackages`.
import { hash as bcryptHash } from "bcryptjs";

/**
 * Central secret material. Production refuses to boot without it (mirroring the
 * `DEPLO_DATABASE_URL` guard in lib/db/pg.ts) - silently deriving every key from a
 * public constant would make all secrets, sessions and the agent CA forgeable.
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
 * Derive a 32-byte key for a given purpose from the root secret. The root secret
 * is fixed for the process lifetime, so the derived key is stable too - memoize
 * per purpose.
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
 * The scrypt work factor NEW hashes are made with. N=65536 rather than the 2^17
 * OWASP names first, deliberately.
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
 * formats.
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
 */
export function passwordNeedsRehash(stored: string): boolean {
  const parsed = parseStoredPassword(stored);
  if (!parsed) return false;
  const work = (x: ScryptParams) => x.N * x.r * x.p;
  return work(parsed.params) < work(SCRYPT_PARAMS);
}

/**
 * Deterministic 32-byte seed for the agent mTLS CA (PLAN P4 / ADR-0006). Stable
 * for the process/secret lifetime (memoized in `deriveKey`), so the CA is
 * reconstructed identically on every restart with no stored CA key.
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
 * Produce a `user:hash` htpasswd line for Traefik's `basicauth` middleware. A
 * credential that leaks with the file should still cost something to break.
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
 * Open a ciphertext, saying WHETHER it opened as well as what came out. Only the
 * decrypt itself knows, which is why the answer is reported from here.
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
 * Open a ciphertext, or `""` if it will not open. The lossy form, kept because
 * most callers genuinely do want a best-effort read (a masked display, an optional
 * field).
 */
export function decryptSecret(payload: string): string {
  const res = tryDecryptSecret(payload);
  return res.ok ? res.value : "";
}

/**
 * {@link decryptSecret} for the call sites where `""` is not an answer.
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
