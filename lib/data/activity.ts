import "server-only";

import { desc, eq } from "drizzle-orm";

import { getDb } from "../db/client";
import { activities as activitiesTable, teams } from "../db/schema/control-plane";
import { assembleActivity, activityToRow } from "./infra-rows";
import { newId, nowIso } from "../ids";
import { requireActiveTeamId } from "../membership";
import type { Activity, ActivityType } from "../types";

/** Activity for the active team only, newest-first, with the LIMIT pushed into SQL. */
export async function listActivity(limit = 20): Promise<Activity[]> {
  const teamId = await requireActiveTeamId();
  const rows = await getDb()
    .select()
    .from(activitiesTable)
    .where(eq(activitiesTable.teamId, teamId))
    // `seq` (bigint identity) breaks a same-timestamp tie deterministically
    // (PLAN §5); the `(team_id, created_at DESC, seq DESC)` index serves this.
    .orderBy(desc(activitiesTable.createdAt), desc(activitiesTable.seq))
    .limit(limit);
  return rows.map(assembleActivity);
}

/** Activity attributed to a given actor (username), newest-first, capped. */
export async function listActivityByActor(
  actor: string,
  limit = 10,
): Promise<Activity[]> {
  const rows = await getDb()
    .select()
    .from(activitiesTable)
    .where(eq(activitiesTable.actor, actor))
    .orderBy(desc(activitiesTable.createdAt), desc(activitiesTable.seq))
    .limit(limit);
  return rows.map(assembleActivity);
}

/**
 * Internal: record an event. Caller is expected to be authorized already.
 *
 * The owning team is derived: from the project's `teamId` when a `projectId` is
 * given, else from the explicit `teamId` argument (used by project-less member /
 * team events). When neither resolves — e.g. a background deploy with no request
 * context — it falls back to the first team so the row is never written team-less
 * (which would make it invisible to every team).
 */
export async function recordActivity(
  type: ActivityType,
  message: string,
  actor: string,
  projectId: string | null = null,
  teamId: string | null = null,
): Promise<void> {
  // Best-effort (PLAN §1(c): an audit-log insert must NEVER roll back the user's
  // action — it stays a standalone, non-transactional, fire-and-forget insert).
  // Awaiting it keeps the write inside the request's lifecycle (no floated query
  // that could outlive a DB connection); any failure is swallowed so the caller's
  // action still succeeds.
  try {
    const db = getDb();
    let resolved = teamId;
    if (!resolved && projectId) {
      const { loadProjectGraph } = await import("./project-graph-load");
      resolved = (await loadProjectGraph(projectId))?.teamId ?? null;
    }
    // Last-resort fallback so a row is never written team-less (invisible to
    // every team) — the first team by creation order. A team_id is NOT NULL +
    // FK, so an empty string would FK-violate; if there is genuinely no team yet
    // the insert is skipped (nothing could meaningfully own the activity).
    if (!resolved) {
      const firstTeam = await db
        .select({ id: teams.id })
        .from(teams)
        .orderBy(teams.createdAt)
        .limit(1);
      resolved = firstTeam[0]?.id ?? null;
    }
    if (!resolved) return;
    const activity: Activity = {
      id: newId("act"),
      teamId: resolved,
      type,
      message,
      actor,
      projectId,
      createdAt: nowIso(),
    };
    await db.insert(activitiesTable).values(activityToRow(activity));
  } catch (e) {
    console.error("[deplo] recordActivity failed:", e);
  }
}
