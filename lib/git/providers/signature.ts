import { createHmac, timingSafeEqual } from "node:crypto";

export function sameSecret(a: string, b: string): boolean {
  // An empty expectation never matches: a secret that no longer decrypts arrives as "" and must verify nothing.
  if (!a || !b) return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function hmacHex(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}
