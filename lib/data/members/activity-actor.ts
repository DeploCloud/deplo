import "server-only";

import { eq } from "drizzle-orm";
import { getDb } from "../../db/client";
import { memberships as membershipsTable } from "../../db/schema/control-plane/access-control";
import { getCurrentUser } from "../../auth/current-user";
import { recordActivity } from "../activity";
import type { ActivityType } from "../../types/activity";

export async function actorName(): Promise<string> {
  return (await getCurrentUser())?.name ?? "an admin";
}

export async function recordForEveryTeamOf(
  type: ActivityType,
  userId: string,
  message: string,
): Promise<void> {
  const rows = await getDb()
    .selectDistinct({ teamId: membershipsTable.teamId })
    .from(membershipsTable)
    .where(eq(membershipsTable.userId, userId));
  const actor = await actorName();
  for (const { teamId } of rows)
    await recordActivity(
      type,
      message,
      actor,
      null,
      teamId,
      "member_access_changed",
    );
}
