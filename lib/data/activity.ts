import "server-only";

import { read, mutate } from "../store";
import { newId, nowIso } from "../ids";
import { assertUser } from "../auth";
import type { Activity, ActivityType } from "../types";

export async function listActivity(limit = 20): Promise<Activity[]> {
  await assertUser();
  return [...read().activities]
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .slice(0, limit);
}

/** Internal: record an event. Caller is expected to be authorized already. */
export function recordActivity(
  type: ActivityType,
  message: string,
  actor: string,
  projectId: string | null = null
) {
  mutate((d) =>
    d.activities.push({
      id: newId("act"),
      type,
      message,
      actor,
      projectId,
      createdAt: nowIso(),
    })
  );
}
