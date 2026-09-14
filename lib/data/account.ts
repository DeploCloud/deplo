import "server-only";

import { and, eq, ne, sql } from "drizzle-orm";
import { getDb } from "../db/client";
import { users as usersTable } from "../db/schema/control-plane/identity";
import { assertUser, currentSessionAuthMethod } from "../auth/current-user";
import {
  setUserPassword,
  verifyUserPassword,
} from "../auth/password-credential";
import {
  markSessionAuthMethod,
  replacementSessionIdFor,
  revokeAllSessions,
} from "../auth/session-records";
import { startSessionFor } from "../auth/sign-in";
import { requirePersonalSession } from "../auth/request-context";
import { assertPasswordPolicy } from "../password-policy";
import { assertPasswordNotPwned } from "../pwned-password";
import { rateLimit } from "../security";
import { isValidUserAvatarValue } from "../apps/avatar-shared";
import { normalizeUsername, validateUsername } from "../username";

/** Update the current user's display name, and their handle when one is given. */
export async function updateProfile(input: {
  name: string;
  username?: string;
}): Promise<void> {
  requirePersonalSession("your account settings");
  const user = await assertUser();
  const name = input.name.trim();
  if (!name) throw new Error("Name is required");
  const db = getDb();
  const patch: { name: string; username?: string } = { name };
  if (input.username !== undefined) {
    const username = normalizeUsername(input.username);
    const invalid = validateUsername(username);
    if (invalid) throw new Error(invalid);
    if (username !== user.username) {
      // `users_username_uq` is the real guard; this only makes it a sentence.
      const taken = await db
        .select({ id: usersTable.id })
        .from(usersTable)
        .where(
          and(ne(usersTable.id, user.id), eq(usersTable.username, username)),
        )
        .limit(1);
      if (taken[0]) throw new Error("That handle is already taken");
      patch.username = username;
    }
  }
  const updated = await db
    .update(usersTable)
    .set(patch)
    .where(eq(usersTable.id, user.id))
    .returning({ id: usersTable.id });
  if (updated.length === 0) throw new Error("User not found");
}

// updateMyAvatar sets or clears the current user's profile picture.
export async function updateMyAvatar(image: string | null): Promise<void> {
  requirePersonalSession("your account settings");
  const user = await assertUser();
  const next = image?.trim() || null;
  if (next && !isValidUserAvatarValue(next))
    throw new Error("Unsupported profile picture");
  const updated = await getDb()
    .update(usersTable)
    .set({ image: next })
    .where(eq(usersTable.id, user.id))
    .returning({ id: usersTable.id });
  if (updated.length === 0) throw new Error("User not found");
}

// Same budget as the 2FA step-up, so a stolen live session cannot brute-force it.
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
  await db.update(usersTable).set({ email }).where(eq(usersTable.id, user.id));
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
  // After the re-auth, not before: a wrong current password is answered locally.
  await assertPasswordNotPwned(input.newPassword);
  await setUserPassword(user.id, input.newPassword);
  // Read BEFORE the revoke, else the replacement demotes a passkey session to a password one.
  const wasPasskeySession = (await currentSessionAuthMethod()) === "passkey";
  // A changed password must log out every stolen or old cookie, the initiator's included.
  await revokeAllSessions(user.id);
  // Best-effort: on failure the change still stands and the initiator re-authenticates.
  try {
    await startSessionFor(user.email, input.newPassword);
    if (wasPasskeySession) {
      const fresh = await replacementSessionIdFor(user.id);
      if (fresh) await markSessionAuthMethod(fresh, user.id, "passkey");
    }
  } catch {
    /* no request scope / cookie write unavailable - logged out is fine */
  }
}
