import "server-only";

import { cache } from "react";

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
 * Where "a passkey counts as two factors" is decided (ADR-0024).
 *
 * Its own module because `lib/membership.ts` asks these questions on every
 * capability check and the rule is subtle enough to deserve one home rather than
 * two copies drifting apart. It sits BELOW membership and ABOVE auth: it reads
 * the session through `lib/auth.ts` and is read by `lib/membership.ts`, and
 * nothing points back the other way - which is what keeps the two of them from
 * becoming a cycle.
 *
 * A passkey is a second factor by construction: the device is possession, and
 * the fingerprint or PIN unlocking it is the other half. deplo enforces the
 * other half rather than assuming it - the plugin's verifiers refuse a ceremony
 * the authenticator did not mark `userVerified` (`requireUserVerified` in
 * lib/auth/better-auth.ts). Remove that guard and everything here becomes false
 * advertising, so the two travel together.
 *
 * **A passkey only counts where it can actually be used.** WebAuthn welds a
 * credential to one hostname, so a row is a second factor on THAT panel address
 * and nowhere else. Every predicate below therefore asks two questions, never
 * one: does this instance have a relying party at all, and was this credential
 * minted for it? Skip that and a panel moved to a new domain would go on
 * reporting an account as protected by something no browser will ever offer it.
 *
 * And a passkey only counts when it was actually USED. Owning one and signing
 * in with a password is one factor, so {@link passkeyCountsForThisRequest} asks
 * what this session presented before the credential is allowed to satisfy
 * anything. Without that, registering a passkey and never touching it again
 * would quietly turn a two-factor policy into a one-factor one.
 *
 * There is deliberately NO `users.has_passkey` column mirroring
 * `two_factor_enabled`: the row IS the fact, and a denormalized copy is one more
 * thing that can still say yes after the credential is gone.
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
export const userHasPasskey = cache(async (userId: string): Promise<boolean> => {
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
});

/**
 * Whether a passkey may count as this REQUEST's second factor.
 *
 * The account-level question ("is there a usable credential") is
 * {@link holdsAPasskey}; this is the request-level one, and both have to be true
 * before a mandate is satisfied. Owning a passkey and never using it must not
 * clear a two-factor policy - that would let one factor do the work of two - so
 * a browser session counts only when the ceremony is what opened it.
 *
 * Null session means the question does not apply, and the answer is yes:
 *
 *  - A **bearer token** presents no factors at all; it inherits the ACCOUNT's
 *    standing, exactly as it does today for an enrolled authenticator app. Note
 *    that `identityForTokenRow` calls `membershipFor` before any identity is
 *    installed, so this branch is also what keeps token authentication working.
 *  - A **background job** (the scheduler, a sweep) has no sign-in to describe.
 *
 * The only thing that is ever demoted is a real, live session that proved itself
 * some other way - which is to say, a password one.
 */
export async function passkeyCountsForThisRequest(): Promise<boolean> {
  // The session ID is what separates "no sign-in to describe" from "a sign-in
  // that presented something else". Reading only the METHOD cannot tell them
  // apart - both answer null - and treating a password session as the former is
  // exactly the hole this function exists to close.
  const sessionId = await currentSessionId();
  if (!sessionId) return true;
  return (await currentSessionAuthMethod()) === "passkey";
}
