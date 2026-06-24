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
  // Best-effort + fire-and-forget (PLAN §1: an audit-log insert must never roll
  // back the user's action). The team is resolved RELATIONALLY from the project
  // when no explicit teamId is given (projects moved to Postgres in cut-set c, so
  // the old `read().projects.find` would resolve nothing). The whole write is
  // floated so a sync caller stays sync and an insert failure is swallowed.
  void writeActivity(type, message, actor, projectId, teamId).catch((e) =>
    console.error("[deplo] recordActivity failed:", e),
  );
}

async function writeActivity(
  type: ActivityType,
  message: string,
  actor: string,
  projectId: string | null,
  teamId: string | null,
): Promise<void> {
  let resolved = teamId;
  if (!resolved && projectId) {
    const { loadProjectGraph } = await import("./project-graph-load");
    resolved = (await loadProjectGraph(projectId))?.teamId ?? null;
  }
  // Last-resort fallback so a row is never written team-less (invisible to every
  // team) — the first JSONB team (activities are still JSONB this cut-set).
  const finalTeamId = resolved ?? read().teams[0]?.id ?? "";
  mutate((data) =>
    data.activities.push({
      id: newId("act"),
      teamId: finalTeamId,
      type,
      message,
      actor,
      projectId,
      createdAt: nowIso(),
    }),
  );
}
