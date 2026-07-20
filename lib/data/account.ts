import "server-only";

import { and, eq, ne, sql } from "drizzle-orm";
import { getDb } from "../db/client";
import { users as usersTable } from "../db/schema/control-plane";
import { assertUser, setSessionCookie } from "../auth";
import { hashPassword, verifyPassword } from "../crypto";

/** Update the current user's display name. */
export async function updateProfile(input: { name: string }): Promise<void> {
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
export async function updateEmail(input: {
  email: string;
  currentPassword: string;
}): Promise<void> {
  const user = await assertUser();
  const email = input.email.toLowerCase().trim();
  if (!email.includes("@")) throw new Error("Enter a valid email address");
  const db = getDb();
  const me = (
    await db
      .select({ passwordHash: usersTable.passwordHash })
      .from(usersTable)
      .where(eq(usersTable.id, user.id))
      .limit(1)
  )[0];
  if (!me) throw new Error("User not found");
  if (!verifyPassword(input.currentPassword, me.passwordHash))
    throw new Error("Current password is incorrect");
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
  const user = await assertUser();
  if (input.newPassword.length < 8)
    throw new Error("Choose a password of at least 8 characters");
  const db = getDb();
  const me = (
    await db
      .select({ passwordHash: usersTable.passwordHash })
      .from(usersTable)
      .where(eq(usersTable.id, user.id))
      .limit(1)
  )[0];
  if (!me) throw new Error("User not found");
  if (!verifyPassword(input.currentPassword, me.passwordHash))
    throw new Error("Current password is incorrect");
  await db
    .update(usersTable)
    .set({
      passwordHash: hashPassword(input.newPassword),
      // Revoke every outstanding session: a changed password must log out anyone
      // holding a stolen/old cookie. The initiator's own cookie is re-issued
      // below so THEY stay signed in.
      tokenVersion: sql`${usersTable.tokenVersion} + 1`,
    })
    .where(eq(usersTable.id, user.id));
  // Best-effort: re-stamp the initiator's cookie at the new token_version so THEY
  // stay signed in while other sessions die. Outside a request scope (tests) or on
  // any failure the change still stands and the initiator simply re-authenticates
  // with the new password — a safe fallback, never a leak.
  try {
    await setSessionCookie(user.id);
  } catch {
    /* no request scope / cookie write unavailable — logged out is fine */
  }
}
