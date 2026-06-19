import "server-only";

import { read, mutate } from "../store";
import { newId, nowIso } from "../ids";
import { requireActiveTeamId } from "../membership";
import type { Activity, ActivityType } from "../types";

/** Activity for the active team only. */
export async function listActivity(limit = 20): Promise<Activity[]> {
  const teamId = await requireActiveTeamId();
  return read()
    .activities.filter((a) => a.teamId === teamId)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .slice(0, limit);
}

/**
 * Internal: record an event. Caller is expected to be authorized already.
 *
 * The owning team is derived synchronously: from the project's `teamId` when a
 * `projectId` is given, else from the explicit `teamId` argument (used by
 * project-less member/team events). When neither resolves — e.g. a background
 * deploy with no request context — it falls back to the first team so the row
 * is never written team-less (which would make it invisible to every team).
 */
export function recordActivity(
  type: ActivityType,
  message: string,
  actor: string,
  projectId: string | null = null,
  teamId: string | null = null,
) {
  const d = read();
  const resolvedTeamId =
    teamId ??
    (projectId
      ? d.projects.find((p) => p.id === projectId)?.teamId ?? null
      : null) ??
    d.teams[0]?.id ??
    "";
  mutate((data) =>
    data.activities.push({
      id: newId("act"),
      teamId: resolvedTeamId,
      type,
      message,
      actor,
      projectId,
      createdAt: nowIso(),
    })
  );
}
