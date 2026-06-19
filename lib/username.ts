/**
 * Pure username helpers (no `server-only`) so they're usable in the data layer,
 * the migration, and client-side validation alike. A username is the instance-
 * wide public handle: lowercase, `[a-z0-9_-]`, 3–32 chars, unique.
 */

export const USERNAME_MIN = 3;
export const USERNAME_MAX = 32;
const VALID = /^[a-z0-9_-]+$/;

/** Lowercase + strip to the allowed charset (does not enforce length). */
export function normalizeUsername(raw: string): string {
  return raw
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Validate a *normalized* username, returning an error message or null. */
export function validateUsername(username: string): string | null {
  if (username.length < USERNAME_MIN)
    return `Username must be at least ${USERNAME_MIN} characters`;
  if (username.length > USERNAME_MAX)
    return `Username must be at most ${USERNAME_MAX} characters`;
  if (!VALID.test(username))
    return "Username may only contain lowercase letters, numbers, - and _";
  return null;
}

/**
 * Derive a candidate username from a name or email and make it unique against
 * `taken` (a set of already-used usernames) by suffixing -2, -3, … Used both at
 * migration time (backfill) and as a default suggestion.
 */
export function uniqueUsername(seed: string, taken: Set<string>): string {
  let base = normalizeUsername(seed).slice(0, USERNAME_MAX);
  if (base.length < USERNAME_MIN) base = `user-${base}`.slice(0, USERNAME_MAX);
  if (base.length < USERNAME_MIN) base = "user";
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const suffix = `-${i}`;
    const candidate = base.slice(0, USERNAME_MAX - suffix.length) + suffix;
    if (!taken.has(candidate)) return candidate;
  }
}
