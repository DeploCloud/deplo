import "server-only";

import { cache } from "@/lib/request-cache";

import { and, eq, exists, sql } from "drizzle-orm";

import { getDb } from "./db/client";
import { passkey as passkeyTable } from "./db/schema/auth";
import { users as usersTable } from "./db/schema/control-plane/identity";
import { passkeyRelyingParty } from "./public-url";
import {
  currentSessionAuthMethod,
  currentSessionId,
} from "./auth/current-user";

// Where "a passkey counts as two factors" is decided (ADR-0024).

// The condition "this account holds a passkey that works on THIS panel", as a SQL fragment.
export const holdsAPasskey = (userIdColumn: typeof usersTable.id) => {
  const rp = passkeyRelyingParty();
  // Not "no rows matched": with no relying party no passkey works here at all.
  if (!rp) return sql<boolean>`false`;
  return exists(
    getDb()
      .select({ one: passkeyTable.id })
      .from(passkeyTable)
      .where(
        and(
          eq(passkeyTable.userId, userIdColumn),
          eq(passkeyTable.rpId, rp.rpId),
        ),
      ),
  );
};

// Whether `userId` holds a passkey that can sign in on this panel.
export const userHasPasskey = cache(
  async (userId: string): Promise<boolean> => {
    const rp = passkeyRelyingParty();
    if (!rp) return false;
    const rows = await getDb()
      .select({ id: passkeyTable.id })
      .from(passkeyTable)
      .where(
        and(eq(passkeyTable.userId, userId), eq(passkeyTable.rpId, rp.rpId)),
      )
      .limit(1);
    return rows.length > 0;
  },
);

// Whether a passkey may count as this REQUEST's second factor; the account-level question is holdsAPasskey.
export async function passkeyCountsForThisRequest(): Promise<boolean> {
  // The session ID separates "no sign-in to describe" from "a sign-in that presented something else".
  const sessionId = await currentSessionId();
  if (!sessionId) return true;
  return (await currentSessionAuthMethod()) === "passkey";
}
