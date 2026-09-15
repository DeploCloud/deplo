import "server-only";

import { and, eq } from "drizzle-orm";
import { getDb } from "../../db/client";
import { memberships as membershipsTable } from "../../db/schema/control-plane/access-control";
import { users as usersTable } from "../../db/schema/control-plane/identity";
import { requireCapability } from "../../membership";
import { recordActivity } from "../activity";
import {
  clearNodeGrants,
  handOverFolders,
  recordFoldersHanded,
} from "../node-grants";
import { actorName } from "./activity-actor";
import { assertAdminCoverage } from "./assignment";
import { teamFounderUserId } from "./roster";

export async function removeMember(userId: string): Promise<void> {
  const {
    teamId,
    userId: actingUserId,
    membership,
  } = await requireCapability("manage_members");
  const actorIsOwner = membership.role === "owner";
  if (userId === actingUserId)
    throw new Error("You can't remove yourself from the team");
  let username = "";
  let handed = 0;
  await getDb().transaction(async (tx) => {
    const founderId = await teamFounderUserId(tx, teamId);
    const rows = await tx
      .select({ id: membershipsTable.id, role: membershipsTable.role })
      .from(membershipsTable)
      .where(
        and(
          eq(membershipsTable.userId, userId),
          eq(membershipsTable.teamId, teamId),
        ),
      )
      .limit(1);
    const m = rows[0];
    if (!m) throw new Error("Member not found");
    if (userId === founderId) {
      throw new Error("The team's primary owner can't be removed.");
    }
    if (m.role === "owner" && !actorIsOwner) {
      throw new Error("Only an owner can remove another owner.");
    }
    await assertAdminCoverage(tx, teamId, userId, null);
    const u = await tx
      .select({ username: usersTable.username })
      .from(usersTable)
      .where(eq(usersTable.id, userId))
      .limit(1);
    username = u[0]?.username ?? "";
    // A grant hangs off the node it names and a folder off its owner, so neither leaves with the membership row.
    await clearNodeGrants(tx, userId, teamId);
    handed = await handOverFolders(
      tx,
      userId,
      teamId,
      founderId ?? actingUserId,
    );
    await tx.delete(membershipsTable).where(eq(membershipsTable.id, m.id));
  });
  await recordActivity(
    "member",
    `Removed ${username || "a member"} from the team`,
    await actorName(),
    null,
    teamId,
    "member_removed",
  );
  await recordFoldersHanded(userId, teamId, handed);
}
