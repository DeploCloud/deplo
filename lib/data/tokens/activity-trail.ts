import "server-only";

import { recordActivity } from "../activity";
import { getCurrentUser } from "../../auth/current-user";
import type { AlertKey } from "../../types/notification";

export async function trail(
  teamIds: string[],
  what: string,
  alert: AlertKey | null = null,
  type: "security" | "mcp" = "security",
): Promise<void> {
  const actor = await actorName();
  for (const teamId of teamIds)
    await recordActivity(type, what, actor, null, teamId, alert);
}

async function actorName(): Promise<string> {
  return (await getCurrentUser())?.name ?? "an admin";
}
