import "server-only";

import { and, eq, ne, sql } from "drizzle-orm";
import { getDb } from "../db/client";
import { users as usersTable } from "../db/schema/control-plane";
import {
  assertUser,
  currentSessionAuthMethod,
  markSessionAuthMethod,
  replacementSessionIdFor,
  revokeAllSessions,
  setUserPassword,
  startSessionFor,
  verifyUserPassword,
} from "../auth";
import { requirePersonalSession } from "../auth/request-context";
import { assertPasswordPolicy } from "../password-policy";
import { assertPasswordNotPwned } from "../pwned-password";
import { rateLimit } from "../security";

/**
 * The current user's own account.
 *
 * Every function here is USER-scoped: no team, and therefore no capability to
 * gate on. `requirePersonalSession` is what keeps an API token out — the account
 * belongs to the person, not to a credential they minted. The password re-check
 * on the two sensitive ones is a second factor, not the boundary.
 */

/** Update the current user's display name. */
export async function updateProfile(input: { name: string }): Promise<void> {
  requirePersonalSession("your account settings");
  const user = await assertUser();
  const name = input.name.trim();
  if (!name) throw new Error("Name is required");
  const updated = await getDb()
    .update(usersTable)
    .set({ name })
    .where(eq(usersTable.id, user.id))
    .returning({ id: usersTable.id });
  if (updated.length === 0) throw new Error("User not found");
}

/** Change the current user's email, after re-checking their password. */
/** Rate-limited current-password re-auth for a settings change — the same budget
 *  as the 2FA step-up (two-factor.ts `stepUpPassword`), so a stolen LIVE session
 *  can't brute-force the current password to escalate to a durable takeover (a
 *  successful change-password logs the real owner out). Not reachable by an API
 *  token — `requirePersonalSession` already blocks those at each caller. */
const REAUTH_LIMIT = { limit: 6, windowMs: 5 * 60_000 };
async function assertCurrentPassword(
  userId: string,
  password: string,
): Promise<void> {
  const limit = await rateLimit(`account-reauth:${userId}`, REAUTH_LIMIT);
  if (!limit.ok)
    throw new Error(`Too many attempts. Try again in ${limit.retryAfterSec}s.`);
  if (!(await verifyUserPassword(userId, password)))
    throw new Error("Current password is incorrect");
}

export async function updateEmail(input: {
  email: string;
  currentPassword: string;
}): Promise<void> {
  requirePersonalSession("your account settings");
  const user = await assertUser();
  const email = input.email.toLowerCase().trim();
  if (!email.includes("@")) throw new Error("Enter a valid email address");
  const db = getDb();
  await assertCurrentPassword(user.id, input.currentPassword);
  const dup = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(
      and(
        ne(usersTable.id, user.id),
        eq(sql`lower(${usersTable.email})`, email),
      ),
    )
    .limit(1);
  if (dup[0]) throw new Error("An account with this email already exists");
  await db
    .update(usersTable)
    .set({ email })
    .where(eq(usersTable.id, user.id));
}

/** Change the current user's password, after verifying the current one. */
export async function changePassword(input: {
  currentPassword: string;
  newPassword: string;
}): Promise<void> {
  requirePersonalSession("your account settings");
  const user = await assertUser();
  assertPasswordPolicy(input.newPassword);
  await assertCurrentPassword(user.id, input.currentPassword);
  // After the re-auth, not before: a wrong current password must be answered
  // locally, without a round trip to an outside API that changes nothing.
  await assertPasswordNotPwned(input.newPassword);
  await setUserPassword(user.id, input.newPassword);
  // Read BEFORE the revoke: the replacement session below is minted from a
  // password, so without carrying this over, changing your password would
  // silently demote a passkey session to a password one - and an account whose
  // team requires two factors would meet the lock screen for no reason it could
  // see. Changing a password does not undo the ceremony that opened the browser
  // session, so the standing travels with it (ADR-0024 §3).
  const wasPasskeySession = (await currentSessionAuthMethod()) === "passkey";
  // Revoke every outstanding session: a changed password must log out anyone
  // holding a stolen/old cookie. That includes the initiator's own, so sign them
  // straight back in with the password they just chose.
  await revokeAllSessions(user.id);
  // Best-effort: outside a request scope (tests) or on any failure the change
  // still stands and the initiator simply re-authenticates with the new password
  // — a safe fallback, never a leak. No team id is passed, so the existing
  // `deplo_team` cookie survives.
  try {
    await startSessionFor(user.email, input.newPassword);
    if (wasPasskeySession) {
      const fresh = await replacementSessionIdFor(user.id);
      if (fresh) await markSessionAuthMethod(fresh, user.id, "passkey");
    }
  } catch {
    /* no request scope / cookie write unavailable — logged out is fine */
  }
}
