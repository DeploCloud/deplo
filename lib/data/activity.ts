import "server-only";

import { desc, eq } from "drizzle-orm";

import { getDb } from "../db/client";
import { activities as activitiesTable, teams } from "../db/schema/control-plane";
import { assembleActivity, activityToRow } from "./infra-rows";
import { getCurrentUser } from "../auth";
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
 * The owning team is derived: from the project's `teamId` when a `appId` is
 * given, else from the explicit `teamId` argument (used by project-less member /
 * team events). When neither resolves — e.g. a background deploy with no request
 * context — it falls back to the first team so the row is never written team-less
 * (which would make it invisible to every team).
 *
 * The actor's user id is resolved HERE (no caller passes it), so the log can render
 * a real identity for a human actor while `actor` stays free text.
 */
export async function recordActivity(
  type: ActivityType,
  message: string,
  actor: string,
  appId: string | null = null,
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
    if (!resolved && appId) {
      const { loadAppGraph } = await import("./app-graph-load");
      resolved = (await loadAppGraph(appId))?.teamId ?? null;
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
      actorUserId: await resolveActorUserId(actor),
      appId,
      createdAt: nowIso(),
    };
    await db.insert(activitiesTable).values(activityToRow(activity));
  } catch (e) {
    console.error("[deplo] recordActivity failed:", e);
  }
}

/**
 * The human behind an `actor` string, or null. Best-effort by design:
 *  - outside a request (a background deploy, a webhook) there is no current user;
 *  - a NON-HUMAN actor ("system" / "github") must never be attributed to whoever
 *    happens to be logged in, so the string has to match the user it names.
 */
async function resolveActorUserId(actor: string): Promise<string | null> {
  try {
    const u = await getCurrentUser();
    if (u && (u.name === actor || u.username === actor)) return u.id;
  } catch {
    // No request scope — leave the row unattributed.
  }
  return null;
}
