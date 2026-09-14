import { createHmac, timingSafeEqual } from "node:crypto";

// Constant-time compare. An EMPTY expectation never matches, whatever arrives -
// the same refusal GitHub's own route makes on `!secret`.
export function sameSecret(a: string, b: string): boolean {
  if (!a || !b) return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  // timingSafeEqual throws on a length mismatch, so the length is checked first
  // and leaks only the length - which a caller controls anyway.
  return x.length === y.length && timingSafeEqual(x, y);
}

// hmacHex - the sha256 HMAC of a raw delivery body, hex encoded.
export function hmacHex(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}
