// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import "server-only";

import { createHash } from "node:crypto";

import { isTestEnv } from "./db/pg";

/**
 * Refuse a password that appears in the Have I Been Pwned breach corpus.
 * K-ANONYMITY: only the first five hex characters of the SHA-1 leave the box.
 */

const RANGE_API = "https://api.pwnedpasswords.com/range/";

/** Short enough that a slow API never feels like a hung form. */
const TIMEOUT_MS = 3_000;

/** Shown verbatim by every surface, including the Better Auth plugin. */
export const PWNED_PASSWORD_MESSAGE =
  "This password has appeared in a data breach. Choose a different one.";

/**
 * True only when the range API positively lists this password. Any failure -
 * offline, DNS, timeout, non-2xx, garbage body - answers false.
 */
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

/** {@link isPasswordPwned} as a guard, for every path that stores a password. */
export async function assertPasswordNotPwned(password: string): Promise<void> {
  // The suite must not reach the network: it writes credentials in hundreds of
  // tests, and on a runner without egress each one would sit out the timeout.
  if (isTestEnv()) return;
  if (await isPasswordPwned(password)) throw new Error(PWNED_PASSWORD_MESSAGE);
}
