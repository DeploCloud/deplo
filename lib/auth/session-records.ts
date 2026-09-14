import "server-only";

import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../db/client";
import { session as sessionTable } from "../db/schema/auth";
import { getAuth } from "./better-auth";

// revokeAllSessions deletes every Better Auth session row for a user.
export async function revokeAllSessions(userId: string): Promise<void> {
  const auth = getAuth();
  if (!auth) return;
  const ctx = await auth.$context;
  await ctx.internalAdapter.deleteUserSessions(userId);
}

// markSessionAuthMethod records that a session was opened by a WebAuthn ceremony.
export async function markSessionAuthMethod(
  sessionId: string,
  userId: string,
  method: "passkey",
): Promise<void> {
  try {
    await getDb()
      .update(sessionTable)
      .set({ authMethod: method })
      .where(
        and(eq(sessionTable.id, sessionId), eq(sessionTable.userId, userId)),
      );
  } catch {
    /* best-effort: the session itself is already valid */
  }
}

// replacementSessionIdFor is the newest session on an account, for the one caller that
// has just revoked every other one. Anywhere else this would be a guess.
export async function replacementSessionIdFor(
  userId: string,
): Promise<string | null> {
  const rows = await getDb()
    .select({ id: sessionTable.id })
    .from(sessionTable)
    .where(eq(sessionTable.userId, userId))
    .orderBy(desc(sessionTable.createdAt))
    .limit(1);
  return rows[0]?.id ?? null;
}
