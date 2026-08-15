import "server-only";

import { and, eq, exists, or } from "drizzle-orm";

import { getDb } from "./db/client";
import { passkey as passkeyTable } from "./db/schema/auth";
import {
  memberships as membershipsTable,
  teamRoles as teamRolesTable,
  teams as teamsTable,
  users as usersTable,
} from "./db/schema/control-plane";

/**
 * Where "a passkey counts as two factors" is decided (ADR-0024).
 *
 * A LEAF module on purpose: `lib/membership.ts` asks these questions on every
 * capability check and `lib/auth.ts` asks one of them on every sign-in, and
 * those two already depend on each other in one direction. Putting the SQL here
 * — reachable from both, importing neither — is what keeps that from becoming a
 * cycle, and it gives the rule one home instead of two copies drifting apart.
 *
 * A passkey is a second factor by construction: the device is possession, and
 * the fingerprint or PIN unlocking it is the other half. deplo enforces the
 * other half rather than assuming it — the plugin's verifiers refuse a ceremony
 * the authenticator did not mark `userVerified` (`requireUserVerified` in
 * lib/auth/better-auth.ts). Remove that guard and everything here becomes false
 * advertising, so the two travel together.
 *
 * There is deliberately NO `users.has_passkey` column mirroring
 * `two_factor_enabled`: the row IS the fact, and a denormalized copy is one more
 * thing that can still say yes after the credential is gone.
 */

/** The condition "this account holds at least one passkey", as a SQL fragment. */
export const holdsAPasskey = (userIdColumn: typeof usersTable.id) =>
  exists(
    getDb()
      .select({ one: passkeyTable.id })
      .from(passkeyTable)
      .where(eq(passkeyTable.userId, userIdColumn)),
  );

/** Whether `userId` holds at least one passkey. */
export async function userHasPasskey(userId: string): Promise<boolean> {
  const rows = await getDb()
    .select({ id: passkeyTable.id })
    .from(passkeyTable)
    .where(eq(passkeyTable.userId, userId))
    .limit(1);
  return rows.length > 0;
}

/**
 * Whether this account must FINISH signing in with a passkey rather than being
 * handed a session for its password alone.
 *
 * True in exactly one shape: a 2FA policy is in force somewhere, the account has
 * no authenticator app, and it does have a passkey. That combination is what the
 * mandate check treats as satisfied — so accepting the password on its own would
 * let ONE factor clear a TWO-factor policy, which is the hole this closes. The
 * person is not blocked: the next screen runs the ceremony they were going to
 * use anyway.
 *
 * By user id and not "the current user": at the point it is asked, nobody is
 * signed in yet.
 */
export async function passkeyLoginRequired(userId: string): Promise<boolean> {
  const rows = await getDb()
    .select({ id: membershipsTable.id })
    .from(membershipsTable)
    .innerJoin(usersTable, eq(usersTable.id, membershipsTable.userId))
    .innerJoin(teamsTable, eq(teamsTable.id, membershipsTable.teamId))
    .leftJoin(teamRolesTable, eq(teamRolesTable.id, membershipsTable.roleId))
    .where(
      and(
        eq(membershipsTable.userId, userId),
        eq(usersTable.twoFactorEnabled, false),
        holdsAPasskey(usersTable.id),
        or(
          eq(teamsTable.requireTwoFactor, true),
          eq(teamRolesTable.requireTwoFactor, true),
        ),
      ),
    )
    .limit(1);
  return rows.length > 0;
}
