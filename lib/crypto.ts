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
 * A dev fallback is used otherwise so the app still runs locally  a warning
 * is emitted once because it is NOT safe for production.
 */
let warned = false;
function rootSecret(): string {
  const s = process.env.DEPLO_SECRET;
  if (s && s.length >= 16) return s;
  if (!warned && process.env.NODE_ENV === "production") {
    warned = true;
    console.warn(
      "[deplo] DEPLO_SECRET is not set or too short  using an insecure dev key. Set DEPLO_SECRET in production.",
    );
  }
  return "deplo-dev-insecure-secret-change-me-please-0000";
}

/** Derive a 32-byte key for a given purpose from the root secret. */
function deriveKey(purpose: string): Buffer {
  return scryptSync(rootSecret(), `deplo:${purpose}`, 32);
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
