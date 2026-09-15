import "server-only";

import { createHash } from "node:crypto";

import { isTestEnv } from "./db/pg";
import { PasswordError } from "./password-policy";

const RANGE_API = "https://api.pwnedpasswords.com/range/";

const TIMEOUT_MS = 3_000;

export const PWNED_PASSWORD_MESSAGE =
  "This password has appeared in a data breach. Choose a different one.";

export async function isPasswordPwned(password: string): Promise<boolean> {
  if (!password) return false;
  const sha1 = createHash("sha1")
    .update(password, "utf8")
    .digest("hex")
    .toUpperCase();
  const prefix = sha1.slice(0, 5);
  const suffix = sha1.slice(5);

  let body: string;
  try {
    const res = await fetch(`${RANGE_API}${prefix}`, {
      headers: { "Add-Padding": "true", "User-Agent": "deplo" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
    if (!res.ok) return false;
    body = await res.text();
  } catch {
    return false;
  }

  return body.split("\n").some((line) => {
    const [hash, count] = line.trim().split(":");
    return hash === suffix && Number(count) > 0;
  });
}

export async function assertPasswordNotPwned(password: string): Promise<void> {
  if (isTestEnv()) return;
  if (await isPasswordPwned(password))
    throw new PasswordError(PWNED_PASSWORD_MESSAGE);
}
