import "server-only";

import { and, eq, inArray } from "drizzle-orm";

import { getDb, type DbTx } from "../db/client";
import {
  appGrants as appGrantsTable,
  apps as appsTable,
  folderGrants as folderGrantsTable,
  folders as foldersTable,
  projectGrants as projectGrantsTable,
  projects as projectsTable,
  users as usersTable,
} from "../db/schema/control-plane";
import { getCurrentUser } from "../auth";
import { recordActivity } from "./activity";

/**
 * What leaving a team leaves behind. A grant hangs off the node it names and a
 * folder off its owner, so neither goes with the membership row: every door that
 * removes a person from a team has to call both.
 */

/** Drop every node grant this user holds inside one team. */
export async function clearNodeGrants(
  tx: DbTx,
  userId: string,
  teamId: string,
): Promise<void> {
  const projectIds = tx
    .select({ id: projectsTable.id })
    .from(projectsTable)
    .where(eq(projectsTable.teamId, teamId));
  const folderIds = tx
    .select({ id: foldersTable.id })
    .from(foldersTable)
    .where(eq(foldersTable.teamId, teamId));
  const appIds = tx
    .select({ id: appsTable.id })
    .from(appsTable)
    .where(eq(appsTable.teamId, teamId));
  await tx
    .delete(projectGrantsTable)
    .where(
      and(
        eq(projectGrantsTable.userId, userId),
        inArray(projectGrantsTable.projectId, projectIds),
      ),
    );
  await tx
    .delete(folderGrantsTable)
    .where(
      and(
        eq(folderGrantsTable.userId, userId),
        inArray(folderGrantsTable.folderId, folderIds),
      ),
    );
  await tx
    .delete(appGrantsTable)
    .where(
      and(
        eq(appGrantsTable.userId, userId),
        inArray(appGrantsTable.appId, appIds),
      ),
    );
}

/**
 * Hand the folders this person owns in a team to `newOwnerId`. A folder is private
 * to its owner, so one whose owner has left would be visible to nobody but a
 * super-user, and the apps inside it would vanish from the team. Returns how many.
 */
export async function handOverFolders(
  tx: DbTx,
  userId: string,
  teamId: string,
  newOwnerId: string,
): Promise<number> {
  const moved = await tx
    .update(foldersTable)
    .set({ ownerUserId: newOwnerId })
    .where(
      and(
        eq(foldersTable.teamId, teamId),
        eq(foldersTable.ownerUserId, userId),
      ),
    )
    .returning({ id: foldersTable.id });
  return moved.length;
}

/** The folders a leaver owned now belong to the team's primary owner: say so. */
export async function recordFoldersHanded(
  userId: string,
  teamId: string,
  handed: number,
): Promise<void> {
  if (handed === 0) return;
  const rows = await getDb()
    .select({ username: usersTable.username })
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);
  await recordActivity(
    "member",
    `${handed} folder${handed === 1 ? "" : "s"} @${rows[0]?.username ?? "a user"} owned now belong to the team's primary owner`,
    (await getCurrentUser())?.name ?? "Someone",
    null,
    teamId,
    "member_access_changed",
  );
}
