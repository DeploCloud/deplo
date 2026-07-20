import "server-only";

import {
  randomBytes,
  scryptSync,
  timingSafeEqual,
  createCipheriv,
  createDecipheriv,
  createHmac,
  createHash,
} from "node:crypto";

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
function deriveKey(purpose: string): Buffer {
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

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, 64);
  return `scrypt$${salt.toString("hex")}$${derived.toString("hex")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  try {
    const [scheme, saltHex, hashHex] = stored.split("$");
    if (scheme !== "scrypt") return false;
    const salt = Buffer.from(saltHex, "hex");
    const expected = Buffer.from(hashHex, "hex");
    const derived = scryptSync(password, salt, expected.length);
    return timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
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
/* htpasswd (Apache MD5 / apr1) for Traefik basicauth                  */
/* ------------------------------------------------------------------ */

/**
 * Produce a `user:hash` htpasswd line for Traefik's `basicauth` middleware,
 * using the Apache MD5 (`$apr1$`) scheme. Traefik accepts MD5/SHA1/bcrypt
 * htpasswd hashes; `apr1` is chosen because it is self-contained in Node's
 * `crypto` (no bcrypt dependency) and is the format `htpasswd` emits by default.
 *
 * The caller is responsible for any compose-level `$`→`$$` escaping — the hash
 * contains literal `$` separators that docker-compose treats as variable
 * interpolation, so a YAML-embedded label must double them. The returned string
 * here is the RAW htpasswd line (single `$`), so it is correct for an env-file /
 * dynamic-config consumer; the renderer escapes it for the label form.
 */
export function htpasswdLine(username: string, password: string): string {
  return `${username}:${apr1(password, apr1Salt())}`;
}

/** A random 8-char salt from the apr1 alphabet (`./0-9A-Za-z`). */
function apr1Salt(): string {
  const alphabet =
    "./0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  const raw = randomBytes(8);
  let out = "";
  for (let i = 0; i < 8; i++) out += alphabet[raw[i] % alphabet.length];
  return out;
}

/**
 * The Apache MD5 (`apr1`) password hash — a 1000-round MD5 construction. A faithful
 * port of the canonical algorithm (apr_md5_encode / FreeBSD crypt-md5) so the
 * output verifies against any standard htpasswd/Traefik basicauth consumer.
 */
function apr1(password: string, salt: string): string {
  const magic = "$apr1$";
  const pw = Buffer.from(password, "utf8");
  const saltBuf = Buffer.from(salt, "utf8");

  const md5 = (b: Buffer): Buffer => createHash("md5").update(b).digest();

  // Initial digest: password + magic + salt + (digest of password+salt+password)
  let ctx = Buffer.concat([pw, Buffer.from(magic), saltBuf]);
  const inner = md5(Buffer.concat([pw, saltBuf, pw]));
  for (let i = pw.length; i > 0; i -= 16) {
    ctx = Buffer.concat([ctx, inner.subarray(0, Math.min(16, i))]);
  }
  // Bit-driven mixing of the password's first byte / a NUL.
  for (let i = pw.length; i > 0; i >>= 1) {
    ctx = Buffer.concat([
      ctx,
      (i & 1) === 1 ? Buffer.from([0]) : pw.subarray(0, 1),
    ]);
  }
  let result = md5(ctx);

  // 1000 strengthening rounds.
  for (let i = 0; i < 1000; i++) {
    let round = Buffer.alloc(0);
    round = Buffer.concat([round, (i & 1) === 1 ? pw : result.subarray(0, 16)]);
    if (i % 3 !== 0) round = Buffer.concat([round, saltBuf]);
    if (i % 7 !== 0) round = Buffer.concat([round, pw]);
    round = Buffer.concat([round, (i & 1) === 1 ? result.subarray(0, 16) : pw]);
    result = md5(round);
  }

  return `${magic}${salt}$${apr1Encode(result)}`;
}

/** The custom base64 ("./0-9A-Za-z") interleaving apr1 uses for its 16-byte digest. */
function apr1Encode(digest: Buffer): string {
  const itoa64 =
    "./0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  const to64 = (value: number, n: number): string => {
    let v = value;
    let s = "";
    for (let i = 0; i < n; i++) {
      s += itoa64[v & 0x3f];
      v >>= 6;
    }
    return s;
  };
  // The fixed byte-triple ordering from the reference implementation.
  let out = "";
  out += to64((digest[0] << 16) | (digest[6] << 8) | digest[12], 4);
  out += to64((digest[1] << 16) | (digest[7] << 8) | digest[13], 4);
  out += to64((digest[2] << 16) | (digest[8] << 8) | digest[14], 4);
  out += to64((digest[3] << 16) | (digest[9] << 8) | digest[15], 4);
  out += to64((digest[4] << 16) | (digest[10] << 8) | digest[5], 4);
  out += to64(digest[11], 2);
  return out;
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

export function decryptSecret(payload: string): string {
  try {
    const [version, ivB64, tagB64, dataB64] = payload.split(".");
    if (version !== "v1") return "";
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
    return dec.toString("utf8");
  } catch {
    return "";
  }
}

/* ------------------------------------------------------------------ */
/* Session tokens (HMAC-signed, stateless)                            */
/* ------------------------------------------------------------------ */

export interface SessionPayload {
  uid: string;
  exp: number; // epoch seconds
}

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

export function signSession(payload: SessionPayload): string {
  const body = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
  const sig = b64url(
    createHmac("sha256", deriveKey("session")).update(body).digest(),
  );
  return `${body}.${sig}`;
}

export function verifySession(
  token: string | undefined,
): SessionPayload | null {
  if (!token) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = b64url(
    createHmac("sha256", deriveKey("session")).update(body).digest(),
  );
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(
      fromB64url(body).toString("utf8"),
    ) as SessionPayload;
    if (typeof payload.exp !== "number" || payload.exp * 1000 < Date.now())
      return null;
    return payload;
  } catch {
    return null;
  }
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
