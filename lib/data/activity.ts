import "server-only";

import { and, desc, eq, inArray, or, sql, type SQL } from "drizzle-orm";

import { getDb } from "../db/client";
import {
  activities as activitiesTable,
  apps as appsTable,
  teams,
} from "../db/schema/control-plane";
import { assembleActivity, activityToRow } from "./infra-rows";
import { authorOf, loadUserIdentities } from "./user-identity";
import { getCurrentUser } from "../auth";
import { newId, nowIso } from "../ids";
import {
  currentMemberScope,
  hasCapability,
  requireActiveTeamId,
} from "../membership";
import { appScopeWhere } from "./app-graph-load";
import { narrowedScope } from "../auth/request-context";
import { dispatchAlert } from "../notify/dispatch";
import type { Activity, ActivityType, AlertKey } from "../types";

/** Activity for the active team only, newest-first, with the LIMIT pushed into SQL. */
export async function listActivity(limit = 20): Promise<Activity[]> {
  return queryActivity(limit);
}

/**
 * The same feed narrowed to what ONE person did — the Activity tab of a member's
 * page. Same gate and same scope as {@link listActivity}, deliberately: "what has
 * this member been doing" is the team's trail read through one actor, not a
 * softer question, and served by `activities_actor_created_idx`.
 */
export async function listActivityByActor(
  userId: string,
  limit = 10,
): Promise<Activity[]> {
  return queryActivity(limit, userId);
}

async function queryActivity(
  limit: number,
  actorUserId?: string,
): Promise<Activity[]> {
  const teamId = await requireActiveTeamId();
  // The trail is who-did-what across the whole team, so it is `view_activity`
  // and not the `view` floor. Soft (empty) rather than a throw: this feeds the
  // Overview card and the Activity page, which both already render "nothing yet".
  if (!(await hasCapability("view_activity"))) return [];
  const rows = await getDb()
    .select()
    .from(activitiesTable)
    .where(
      and(
        eq(activitiesTable.teamId, teamId),
        actorUserId
          ? eq(activitiesTable.actorUserId, actorUserId)
          : undefined,
        // An API token limited to Projects reads only its own apps' history.
        // Team-level events (`app_id IS NULL` — members, roles, tokens, the team
        // itself) belong to nothing it can reach, so they drop out with the rest.
        await scopedActivityWhere(),
      ),
    )
    // `seq` (bigint identity) breaks a same-timestamp tie deterministically
    // (PLAN §5); the `(team_id, created_at DESC, seq DESC)` index serves this.
    .orderBy(desc(activitiesTable.createdAt), desc(activitiesTable.seq))
    .limit(limit);
  // One query for the whole page, the same batch the env authors use: the trail
  // shows who did it, and a name with no face is exactly what this reads as.
  const authors = await loadUserIdentities(rows.map((r) => r.actorUserId));
  return rows.map((row) => ({
    ...assembleActivity(row),
    actorUser: authorOf(row.actorUserId, authors),
  }));
}

/**
 * The scope predicate for the audit feed, or undefined for a caller who reaches
 * the whole team.
 *
 * The trail is where "who did what" is answered, so a limited principal sees the
 * events of the apps they reach and NOTHING else — team-level rows included
 * (`app_id IS NULL`: member added, role edited, token minted), which are the
 * team's own history rather than any app's.
 *
 * Async because a person's reach lives in the database, and it asks about both:
 * a token narrows through `appScopeWhere`, a role through its own id list, and
 * the two compose as a conjunction.
 */
async function scopedActivityWhere(): Promise<SQL | undefined> {
  const roleScope = await currentMemberScope();
  if (!narrowedScope() && !roleScope) return undefined;
  const clauses = [appScopeWhere()].filter(
    (c): c is SQL => c !== undefined,
  );
  if (roleScope) {
    const alt: SQL[] = [];
    if (roleScope.projectIds.length)
      alt.push(inArray(appsTable.projectId, roleScope.projectIds));
    if (roleScope.environmentIds.length)
      alt.push(inArray(appsTable.environmentId, roleScope.environmentIds));
    if (roleScope.folderIds.length)
      alt.push(inArray(appsTable.folderId, roleScope.folderIds));
    if (roleScope.appIds.length) alt.push(inArray(appsTable.id, roleScope.appIds));
    // Spelled out rather than relying on `inArray(col, [])`, whose behaviour has
    // changed across Drizzle versions: a scope with nothing left reaches nothing.
    clauses.push(alt.length === 0 ? sql`false` : alt.length === 1 ? alt[0] : or(...alt)!);
  }
  // Reuses the ONE app predicate the whole data layer scopes by, so the feed can
  // never disagree with what `listApps` shows.
  return inArray(
    activitiesTable.appId,
    getDb()
      .select({ id: appsTable.id })
      .from(appsTable)
      .where(clauses.length === 1 ? clauses[0] : and(...clauses)),
  );
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
 *
 * `alert` is the optional sixth argument: a call site that is also worth PUSHING
 * to the team names its alert key here, and the dispatch happens once, in this
 * function, on the team it already resolved. Naming the key at the call site
 * rather than classifying `message` is deliberate — `type: "member"` covers
 * everything from a role edit to a Traefik restart, and matching on free text
 * would be a guess that breaks the first time somebody rewords a string.
 */
export async function recordActivity(
  type: ActivityType,
  message: string,
  actor: string,
  appId: string | null = null,
  teamId: string | null = null,
  alert: AlertKey | null = null,
): Promise<void> {
  // Best-effort (PLAN §1(c): an audit-log insert must NEVER roll back the user's
  // action — it stays a standalone, non-transactional, fire-and-forget insert).
  // Awaiting it keeps the write inside the request's lifecycle (no floated query
  // that could outlive a DB connection); any failure is swallowed so the caller's
  // action still succeeds.
  //
  // Swallowed, but no longer lost quietly: see {@link insertActivityRow} for the
  // retry, and {@link flushDroppedMarker} for why a gap in the trail has to be
  // legible in the trail itself rather than only in the process's stderr.
  // Whether the row actually landed. Read by the catch below so that a failure
  // AFTER the insert - the alert dispatch, say - is not counted as a lost
  // entry: a marker claiming something was dropped when it was written is a
  // false alarm in the one place that has to be believable.
  let written = false;
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
      // Resolved on the way OUT, per list. Nothing on the write path needs it.
      actorUser: null,
      appId,
      createdAt: nowIso(),
    };
    await insertActivityRow(activity);
    written = true;
    // Written AFTER the row it follows, so the marker cannot itself be the
    // thing that fails and leaves the real entry missing.
    await flushDroppedMarker(resolved);
    // The audit row is already written in the dashboard's own voice, so the
    // alert reuses it verbatim rather than inventing a second phrasing.
    if (alert)
      dispatchAlert({
        teamId: resolved,
        key: alert,
        title: message,
        body: `By ${actor}.`,
        path: "/activity",
      });
  } catch (e) {
    if (!written) droppedEntries += 1;
    console.error("[deplo] recordActivity failed:", e);
  }
}

/**
 * How many entries this process failed to write.
 *
 * An audit trail that can lose rows without saying so is not an audit trail: the
 * question a company actually asks it ("who did this, and when") is answered by
 * ABSENCE as much as by presence, and an absence with no marker reads as "nobody
 * did anything". A `console.error` on a self-hosted box is not an answer -
 * nobody is tailing that log, and the person who needs to know is looking at the
 * Activity page.
 *
 * Process-global rather than per-team on purpose: a failure can happen before
 * the team is even resolved, so there is frequently no team to attribute it to.
 * The marker therefore says what is true - this instance dropped entries -
 * rather than claiming which team's they were.
 */
let droppedEntries = 0;

/**
 * Insert the row, with ONE retry.
 *
 * The overwhelming cause of a lost entry is transient: a pool timeout, a
 * connection recycled underneath the write, a database restarted while a deploy
 * was finishing. One retry a moment later converts most of those into a row that
 * is simply there. More than one would start to matter to the request the caller
 * is still inside, and the marker below covers what retrying cannot.
 */
async function insertActivityRow(activity: Activity): Promise<void> {
  try {
    await getDb().insert(activitiesTable).values(activityToRow(activity));
    return;
  } catch (e) {
    console.warn("[deplo] recordActivity insert failed, retrying once:", e);
  }
  await new Promise((r) => setTimeout(r, 150));
  await getDb().insert(activitiesTable).values(activityToRow(activity));
}

/**
 * Leave a legible hole where the lost entries were.
 *
 * Runs on the next SUCCESSFUL write, which is the first moment we know the
 * database is answering again. Its own failure is swallowed and the count kept:
 * the marker is worth retrying forever, and losing the count would be losing the
 * only record that anything was lost at all.
 */
async function flushDroppedMarker(teamId: string): Promise<void> {
  if (droppedEntries === 0) return;
  const n = droppedEntries;
  try {
    await getDb()
      .insert(activitiesTable)
      .values(
        activityToRow({
          id: newId("act"),
          teamId,
          actorUser: null,
          type: "member",
          message:
            n === 1
              ? "1 activity entry could not be recorded on this instance"
              : `${n} activity entries could not be recorded on this instance`,
          actor: "Deplo",
          actorUserId: null,
          appId: null,
          createdAt: nowIso(),
        }),
      );
    droppedEntries -= n;
  } catch (e) {
    console.error("[deplo] could not record the dropped-activity marker:", e);
  }
}

/**
 * The human behind an `actor` string, or null. Best-effort by design:
 *  - outside a request (a background deploy, a webhook) there is no current user;
 *  - a NON-HUMAN actor ("system" / "github") must never be attributed to whoever
 *    happens to be logged in, so the string has to match the user it names.
 */
export async function resolveActorUserId(actor: string): Promise<string | null> {
  try {
    const u = await getCurrentUser();
    if (u && (u.name === actor || u.username === actor)) return u.id;
  } catch {
    // No request scope — leave the row unattributed.
  }
  return null;
}
