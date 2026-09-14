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

/** Remove a member from the active team (does not delete their account). */
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
    // The ABSOLUTE owner (founder / "crown") can never be removed by anyone,
    // including instance admins, so the team always keeps its creator.
    if (userId === founderId) {
      throw new Error("The team's primary owner can't be removed.");
    }
    // An (assigned) owner outranks non-owners: only another owner may remove an
    // owner. A non-owner manager can remove only non-owners.
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
    // Neither hangs off the membership row: a grant names its node, a folder its
    // owner. Left behind, the grants come back with the person and the folders
    // stay private to someone who is no longer here.
    await clearNodeGrants(tx, userId, teamId);
    handed = await handOverFolders(
      tx,
      userId,
      teamId,
      founderId ?? actingUserId,
    );
    // membership_capabilities cascades on the membership FK.
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
