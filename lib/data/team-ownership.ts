import "server-only";

import { and, eq } from "drizzle-orm";
import { getDb } from "../db/client";
import {
  membershipCapabilities as membershipCapabilitiesTable,
  memberships as membershipsTable,
} from "../db/schema/control-plane/access-control";
import {
  teams as teamsTable,
  users as usersTable,
} from "../db/schema/control-plane/identity";
import { assertUser } from "../auth/current-user";
import { requirePersonalSession } from "../auth/request-context";
import { requireCapability } from "../membership";
import { capabilitiesForRole } from "../membership-shared";
import { recordActivity } from "./activity";
import { ensureTeamRoles } from "./roles/builtin-roles";
import { clearNodeGrants } from "./node-grants";
import { stepUpCode, stepUpPassword } from "./two-factor";

// Handing a TEAM to somebody else - the only write of `teams.founder_user_id` after creation.
export async function transferTeamOwnership(input: {
  userId: string;
  password: string;
  code?: string;
}): Promise<void> {
  requirePersonalSession("team ownership");
  const { teamId, userId: actingUserId } =
    await requireCapability("manage_team");
  const actor = await assertUser();
  if (input.userId === actingUserId)
    throw new Error("You already own this team");

  // Step up BEFORE the transaction: a consumed recovery code is not rolled back.
  await stepUpPassword(input.password);
  if (actor.twoFactorEnabled) await stepUpCode(input.code ?? "");

  // Seeded outside the transaction: ensureTeamRoles commits its own inserts.
  const db = getDb();
  const ownerRoleId = (await ensureTeamRoles(db, teamId)).get("owner") ?? null;
  const ownerCapabilities = capabilitiesForRole("owner");

  const targetUsername = await db.transaction(async (tx) => {
    const team = (
      await tx
        .select({ founderUserId: teamsTable.founderUserId })
        .from(teamsTable)
        .where(eq(teamsTable.id, teamId))
        .for("update")
        .limit(1)
    )[0];
    if (!team) throw new Error("Team not found");
    // A legacy team whose founder column was never backfilled has no crown to hand
    // over, and inventing one here would let any owner claim it.
    if (team.founderUserId === null)
      throw new Error("This team has no primary owner to transfer.");
    if (team.founderUserId !== actingUserId)
      throw new Error("Only the team's primary owner can transfer ownership");

    const target = (
      await tx
        .select({
          membershipId: membershipsTable.id,
          username: usersTable.username,
          suspended: usersTable.suspended,
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

    await tx
      .update(membershipsTable)
      .set({
        role: "owner",
        roleId: ownerRoleId,
        granular: false,
        customCapabilities: false,
      })
      .where(
        and(
          eq(membershipsTable.userId, input.userId),
          eq(membershipsTable.teamId, teamId),
        ),
      );
    await tx
      .delete(membershipCapabilitiesTable)
      .where(eq(membershipCapabilitiesTable.membershipId, target.membershipId));
    await tx.insert(membershipCapabilitiesTable).values(
      ownerCapabilities.map((c) => ({
        membershipId: target.membershipId,
        capability: c,
      })),
    );
    await clearNodeGrants(tx, input.userId, teamId);

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
    teamId,
    "team_ownership_changed",
  );
}
