import "server-only";

import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../db/client";
import { session as sessionTable } from "../db/schema/auth";
import { getAuth } from "./better-auth";

export async function revokeAllSessions(userId: string): Promise<void> {
  const auth = getAuth();
  if (!auth) return;
  const ctx = await auth.$context;
  await ctx.internalAdapter.deleteUserSessions(userId);
}

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
  } catch {}
}

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
