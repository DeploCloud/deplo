import "server-only";

import { cache } from "@/lib/request-cache";

import { and, eq, exists, or, sql } from "drizzle-orm";

import { getDb } from "./db/client";
import { passkey as passkeyTable } from "./db/schema/auth";
import {
  memberships as membershipsTable,
  teamRoles as teamRolesTable,
  teams as teamsTable,
  users as usersTable,
} from "./db/schema/control-plane";
import { passkeyRelyingParty } from "./public-url";
import { currentSessionAuthMethod, currentSessionId } from "./auth";

/**
 * Where "a passkey counts as two factors" is decided (ADR-0024). Remove that guard
 * and everything here becomes false advertising, so the two travel together.
 */

/**
 * The condition "this account holds a passkey that works on THIS panel", as a
 * SQL fragment. Always false when the instance has no relying party (no address,
 * or plain http), because then no passkey works here at all.
 */
export const holdsAPasskey = (userIdColumn: typeof usersTable.id) => {
  const rp = passkeyRelyingParty();
  // Not "no rows matched": there is no relying party, so the question does not
  // apply here at all. A plain false keeps both call sites - a projection and a
  // WHERE clause - from having to special-case it.
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

/**
 * Whether `userId` holds a passkey that can sign in on this panel.
 *
 * Request-cached: the dashboard layout asks on every page load (the reminder and
 * the lock screen both need it) and the Security page asks again.
 */
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

/**
 * Whether a passkey may count as this REQUEST's second factor. The account-level
 * question ("is there a usable credential") is {@link holdsAPasskey}; this is the
 * request-level one, and both have to be true before a mandate is satisfied.
 */
export async function passkeyCountsForThisRequest(): Promise<boolean> {
  // The session ID is what separates "no sign-in to describe" from "a sign-in that
  // presented something else".
  const sessionId = await currentSessionId();
  if (!sessionId) return true;
  return (await currentSessionAuthMethod()) === "passkey";
}
