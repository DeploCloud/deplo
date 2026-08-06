import "server-only";

import { and, eq } from "drizzle-orm";
import { getDb } from "../db/client";
import {
  memberships as membershipsTable,
  teams as teamsTable,
  users as usersTable,
} from "../db/schema/control-plane";
import { assertUser } from "../auth";
import { requirePersonalSession } from "../auth/request-context";
import { requireCapability } from "../membership";
import { recordActivity } from "./activity";
import { stepUpCode, stepUpPassword } from "./two-factor";

/**
 * Handing a TEAM to somebody else — the team-level twin of
 * {@link transferInstanceOwner} (lib/data/instance-owner.ts), and the only thing
 * that ever writes `teams.founder_user_id` after the team is created.
 *
 * WHY IT HAS TO EXIST. The founder ("crown") is immutable by design: they cannot
 * be removed, demoted or edited by anyone, which is what stops an assigned owner
 * from evicting the person who created the team. Without a transfer that same
 * rule means a founder who leaves the company owns the team forever, and the
 * honest answer to "how do we get it back" is a SQL prompt — which is exactly the
 * answer the product promises never to give.
 *
 * WHAT IT COSTS TO DO IT. The caller's password, plus a live second factor when
 * their account has one. Password-only is what the instance transfer asks, and it
 * is the floor here too: a session cookie on a borrowed laptop must not be able
 * to give a team away. Asking for the code as well when 2FA is on costs the
 * account nothing it has not already set up, and matches every other irreversible
 * step-up in the product (lib/data/two-factor.ts). An API token cannot do this at
 * all: a CI credential has no business handing over a company's team.
 */
export async function transferTeamOwnership(input: {
  userId: string;
  password: string;
  /** A TOTP or recovery code. Required only when the caller's own 2FA is on. */
  code?: string;
}): Promise<void> {
  requirePersonalSession("team ownership");
  const { teamId, userId: actingUserId } = await requireCapability("manage_team");
  const actor = await assertUser();
  if (input.userId === actingUserId)
    throw new Error("You already own this team");

  // Step up BEFORE the transaction: both halves are rate limited per account and
  // a recovery code is consumed on success, so neither belongs inside a write
  // that may still be rolled back by a guard below.
  await stepUpPassword(input.password);
  if (actor.twoFactorEnabled) await stepUpCode(input.code ?? "");

  const targetUsername = await getDb().transaction(async (tx) => {
    // Lock the team row first: two concurrent transfers must serialize, or both
    // could read "I am the founder" and the second would overwrite the first.
    const team = (
      await tx
        .select({ founderUserId: teamsTable.founderUserId })
        .from(teamsTable)
        .where(eq(teamsTable.id, teamId))
        .for("update")
        .limit(1)
    )[0];
    if (!team) throw new Error("Team not found");
    // A legacy team whose founder column was never backfilled has no crown to
    // hand over, and inventing one here would let any owner claim it.
    if (team.founderUserId === null)
      throw new Error("This team has no primary owner to transfer.");
    if (team.founderUserId !== actingUserId)
      throw new Error("Only the team's primary owner can transfer ownership");

    const target = (
      await tx
        .select({
          username: usersTable.username,
          suspended: usersTable.suspended,
          role: membershipsTable.role,
        })
        .from(membershipsTable)
        .innerJoin(usersTable, eq(usersTable.id, membershipsTable.userId))
        .where(
          and(
            eq(membershipsTable.userId, input.userId),
            eq(membershipsTable.teamId, teamId),
          ),
        )
        .limit(1)
    )[0];
    if (!target) throw new Error("They aren't a member of this team");
    if (target.suspended)
      throw new Error("You can't hand this team to a suspended account");
    // The crown implies the rank, so the rank has to be there already. Promoting
    // them here instead would hand out the owner role as a side effect of a
    // dialog that never mentioned it.
    if (target.role !== "owner")
      throw new Error(
        "You can only hand this team to an owner. Give them the Owner role first.",
      );

    await tx
      .update(teamsTable)
      .set({ founderUserId: input.userId })
      .where(eq(teamsTable.id, teamId));
    return target.username;
  });

  // Outside the transaction, per the recordActivity rule (own connection).
  await recordActivity(
    "member",
    `Transferred ownership of this team to @${targetUsername}`,
    actor.username,
    null,
  );
}
