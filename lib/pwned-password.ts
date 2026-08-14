import "server-only";

import { createHash } from "node:crypto";

import { isTestEnv } from "./db/pg";

/**
 * Refuse a password that appears in the Have I Been Pwned breach corpus.
 *
 * The same check Better Auth's `haveIBeenPwned` plugin performs - that plugin IS
 * mounted (lib/auth/better-auth.ts) and covers its own `/api/auth/*` endpoints -
 * repeated here because deplo never writes a credential through those endpoints.
 * First-run setup, the registration link, the account settings, the admin reset,
 * basic auth, the Traefik panel and a database's engine password all go through
 * `lib/data`, and the plugin only fires on a Better Auth request path. Both
 * surfaces raise the same sentence, so a password refused in one place reads
 * identically in the other.
 *
 * K-ANONYMITY: only the first five hex characters of the SHA-1 leave the box.
 * The API answers with every suffix sharing that prefix (~800 of them) and the
 * comparison happens here, so neither the password nor a full hash of it is ever
 * sent anywhere. `Add-Padding` pads the answer to a fixed-ish size, so its length
 * tells an observer nothing either; the decoy lines it adds carry a count of 0,
 * which is why the count is parsed rather than the suffix matched alone.
 *
 * FAILS OPEN, deliberately, and this is the part not to "fix" later. A
 * self-hosted instance may have no egress at all, and the very first password
 * anyone types is the one that creates the instance owner: a check that turns
 * "api.pwnedpasswords.com is unreachable" into "you cannot finish setup" bricks
 * first run over an advisory signal. Same trade the rate limiter takes in
 * lib/security.ts. Only a CONFIRMED hit refuses.
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
  const sha1 = createHash("sha1").update(password, "utf8").digest("hex").toUpperCase();
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
