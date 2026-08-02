import "server-only";

import { and, eq, ne, sql } from "drizzle-orm";
import { getDb } from "../db/client";
import { users as usersTable } from "../db/schema/control-plane";
import {
  assertUser,
  revokeAllSessions,
  setUserPassword,
  startSessionFor,
  verifyUserPassword,
} from "../auth";

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
  if (!(await verifyUserPassword(user.id, input.currentPassword)))
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
  if (!(await verifyUserPassword(user.id, input.currentPassword)))
    throw new Error("Current password is incorrect");
  await setUserPassword(user.id, input.newPassword);
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
  } catch {
    /* no request scope / cookie write unavailable — logged out is fine */
  }
}
