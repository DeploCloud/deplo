import "server-only";

import {
  and,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lt,
  or,
  sql,
  type SQL,
} from "drizzle-orm";

import { getDb } from "../db/client";
import {
  activities as activitiesTable,
  apps as appsTable,
  databases as databasesTable,
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
import type { Activity, ActivityType, AlertKey, VarAuthor } from "../types";

/**
 * Picks the rows with no human behind them (`actor_user_id IS NULL`). User ids are
 * `usr_`-prefixed, so this cannot collide with one.
 */
export const ACTOR_SYSTEM = "system";

/**
 * What the Activity page narrows the feed by. Every field is AND-ed with the
 * others and OR-ed within itself, and none of them ever WIDENS what the caller
 * reaches - the scope predicate below is applied on top regardless.
 */
export interface ActivityFilter {
  /** User ids, plus {@link ACTOR_SYSTEM} for the non-human actors. */
  actorUserIds?: string[];
  types?: ActivityType[];
  /** ISO, inclusive. */
  from?: string;
  /** ISO, exclusive. */
  to?: string;
  /** App, folder, project and database ids mixed - resolved to what they cover. */
  resourceIds?: string[];
  /** Keyset position: the last row of the previous page. */
  cursor?: { createdAt: string; seq: number };
}

/** Activity for the active team only, newest-first, with the LIMIT pushed into SQL. */
export async function listActivity(
  limit = 20,
  filter: ActivityFilter = {},
): Promise<Activity[]> {
  return queryActivity(limit, filter);
}

/**
 * The same feed narrowed to what ONE person did - the Activity tab of a member's
 * page.
 */
export async function listActivityByActor(
  userId: string,
  limit = 10,
): Promise<Activity[]> {
  return queryActivity(limit, { actorUserIds: [userId] });
}

/**
 * The filter predicates, minus the team and the scope. Arrays are spelled out
 * rather than handed to `inArray(col, [])`, whose behaviour has changed across
 * Drizzle versions.
 */
function activityFilterWhere(
  teamId: string,
  f: ActivityFilter,
): (SQL | undefined)[] {
  const out: (SQL | undefined)[] = [];
  if (f.actorUserIds?.length) {
    const people = f.actorUserIds.filter((id) => id !== ACTOR_SYSTEM);
    const alt: SQL[] = [];
    if (people.length) alt.push(inArray(activitiesTable.actorUserId, people));
    if (f.actorUserIds.includes(ACTOR_SYSTEM))
      alt.push(isNull(activitiesTable.actorUserId));
    out.push(alt.length === 1 ? alt[0] : or(...alt)!);
  }
  if (f.types?.length) out.push(inArray(activitiesTable.type, f.types));
  if (f.from) out.push(gte(activitiesTable.createdAt, f.from));
  if (f.to) out.push(lt(activitiesTable.createdAt, f.to));
  if (f.resourceIds?.length)
    // Team-level rows (both pointers NULL) drop out here, the same way they do for
    // a scoped caller: asking what happened to an app is not asking about the team.
    // Both sub-selects are team-bound, so an id from another team widens nothing.
    out.push(
      or(
        inArray(
          activitiesTable.appId,
          getDb()
            .select({ id: appsTable.id })
            .from(appsTable)
            .where(
              and(
                eq(appsTable.teamId, teamId),
                or(
                  inArray(appsTable.id, f.resourceIds),
                  inArray(appsTable.folderId, f.resourceIds),
                  inArray(appsTable.projectId, f.resourceIds),
                )!,
              ),
            ),
        ),
        inArray(
          activitiesTable.databaseId,
          getDb()
            .select({ id: databasesTable.id })
            .from(databasesTable)
            .where(
              and(
                eq(databasesTable.teamId, teamId),
                inArray(databasesTable.id, f.resourceIds),
              ),
            ),
        ),
      )!,
    );
  if (f.cursor)
    // The ROW form, not the expanded `a < x OR (a = x AND b < y)`: Postgres takes
    // this one as an Index Cond on `(team_id, created_at DESC, seq DESC)`, and
    // the expanded form only as a bound on `created_at` plus a filter.
    out.push(
      sql`(${activitiesTable.createdAt}, ${activitiesTable.seq}) < (${f.cursor.createdAt}::timestamptz, ${f.cursor.seq}::bigint)`,
    );
  return out;
}

async function queryActivity(
  limit: number,
  filter: ActivityFilter,
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
        ...activityFilterWhere(teamId, filter),
        // An API token limited to Projects reads only its own apps' history.
        // Team-level events (`app_id IS NULL` - members, roles, tokens, the team
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
 * the whole team. Databases are not folder/project-scoped, so a narrowed caller
 * reaches no database row at all - the same answer they got before `database_id`.
 */
async function scopedActivityWhere(): Promise<SQL | undefined> {
  const roleScope = await currentMemberScope();
  if (!narrowedScope() && !roleScope) return undefined;
  const clauses = [appScopeWhere()].filter((c): c is SQL => c !== undefined);
  if (roleScope) {
    const alt: SQL[] = [];
    if (roleScope.projectIds.length)
      alt.push(inArray(appsTable.projectId, roleScope.projectIds));
    if (roleScope.environmentIds.length)
      alt.push(inArray(appsTable.environmentId, roleScope.environmentIds));
    if (roleScope.folderIds.length)
      alt.push(inArray(appsTable.folderId, roleScope.folderIds));
    if (roleScope.appIds.length)
      alt.push(inArray(appsTable.id, roleScope.appIds));
    // Spelled out rather than relying on `inArray(col, [])`, whose behaviour has
    // changed across Drizzle versions: a scope with nothing left reaches nothing.
    clauses.push(
      alt.length === 0 ? sql`false` : alt.length === 1 ? alt[0] : or(...alt)!,
    );
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
 * How many events fall in each month, for the feed's month headers. Same filters
 * as the feed minus the cursor, so the counts describe the whole filtered range
 * and not the page that has been scrolled to.
 */
export async function activityMonths(
  filter: ActivityFilter = {},
  tz = "UTC",
): Promise<{ month: string; count: number }[]> {
  const teamId = await requireActiveTeamId();
  if (!(await hasCapability("view_activity"))) return [];
  // `to_char`, not `date_trunc`: a raw timestamptz expression does not pass the
  // column's `fromDriver`, so it would come back formatted in the SESSION's
  // TimeZone. And GROUP BY takes the ORDINAL - Drizzle renders the same `sql`
  // object unqualified in the select and qualified in the GROUP BY, which
  // Postgres rejects.
  const month = sql<string>`to_char(${activitiesTable.createdAt} at time zone ${tz}, 'YYYY-MM')`;
  return getDb()
    .select({
      month: month.as("month"),
      count: sql<number>`count(*)::int`.as("count"),
    })
    .from(activitiesTable)
    .where(
      and(
        eq(activitiesTable.teamId, teamId),
        ...activityFilterWhere(teamId, { ...filter, cursor: undefined }),
        await scopedActivityWhere(),
      ),
    )
    .groupBy(sql`1`)
    .orderBy(sql`1 desc`);
}

/**
 * Everyone who appears in this team's trail, for the feed's actor filter. Read
 * off the activity itself rather than the member list, so someone who has since
 * left stays pickable. Every non-human writer ("Deplo", "system", a webhook)
 * collapses into the one {@link ACTOR_SYSTEM} option, which is all the column
 * can tell apart.
 */
export async function listActivityActors(): Promise<
  { value: string; label: string; author: VarAuthor | null }[]
> {
  const teamId = await requireActiveTeamId();
  if (!(await hasCapability("view_activity"))) return [];
  const rows = await getDb()
    .selectDistinct({
      actorUserId: activitiesTable.actorUserId,
      actor: activitiesTable.actor,
    })
    .from(activitiesTable)
    .where(
      and(eq(activitiesTable.teamId, teamId), await scopedActivityWhere()),
    );
  const authors = await loadUserIdentities(rows.map((r) => r.actorUserId));
  const seen = new Set<string>();
  const out: { value: string; label: string; author: VarAuthor | null }[] = [];
  for (const row of rows) {
    const value = row.actorUserId ?? ACTOR_SYSTEM;
    if (seen.has(value)) continue;
    seen.add(value);
    const author = authorOf(row.actorUserId, authors);
    out.push({
      value,
      label: value === ACTOR_SYSTEM ? "System" : (author?.name ?? row.actor),
      author,
    });
  }
  // The system bucket last: it is a catch-all, not a person.
  return out.sort((a, b) =>
    a.value === ACTOR_SYSTEM
      ? 1
      : b.value === ACTOR_SYSTEM
        ? -1
        : a.label.localeCompare(b.label),
  );
}

/**
 * Internal: record an event. When neither resolves - e.g. a background deploy with
 * no request context - it falls back to the first team so the row is never written
 * team-less (which would make it invisible to every team).
 */
export async function recordActivity(
  type: ActivityType,
  message: string,
  actor: string,
  appId: string | null = null,
  teamId: string | null = null,
  alert: AlertKey | null = null,
  databaseId: string | null = null,
): Promise<void> {
  // Best-effort (PLAN §1(c): an audit-log insert must NEVER roll back the user's
  // action - it stays a standalone, non-transactional, fire-and-forget insert).
  let written = false;
  try {
    const db = getDb();
    let resolved = teamId;
    if (!resolved && appId) {
      const { loadAppGraph } = await import("./app-graph-load");
      resolved = (await loadAppGraph(appId))?.teamId ?? null;
    }
    // Last-resort fallback so a row is never written team-less (invisible to every
    // team) - the first team by creation order.
    if (!resolved) {
      const firstTeam = await db
        .select({ id: teams.id })
        .from(teams)
        .orderBy(teams.createdAt)
        .limit(1);
      resolved = firstTeam[0]?.id ?? null;
    }
    if (!resolved) return;
    const activity: Omit<Activity, "seq"> = {
      id: newId("act"),
      teamId: resolved,
      type,
      message,
      actor,
      actorUserId: await resolveActorUserId(actor),
      // Resolved on the way OUT, per list. Nothing on the write path needs it.
      actorUser: null,
      appId,
      databaseId,
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
 * How many entries this process failed to write. Process-global rather than
 * per-team on purpose: a failure can happen before the team is even resolved, so
 * there is frequently no team to attribute it to.
 */
let droppedEntries = 0;

/**
 * Insert the row, with ONE retry. More than one would start to matter to the
 * request the caller is still inside, and the marker below covers what retrying
 * cannot.
 */
async function insertActivityRow(
  activity: Omit<Activity, "seq">,
): Promise<void> {
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
 * Leave a legible hole where the lost entries were. Runs on the next SUCCESSFUL
 * write, which is the first moment we know the database is answering again.
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
          type: "instance",
          message:
            n === 1
              ? "1 activity entry could not be recorded on this instance"
              : `${n} activity entries could not be recorded on this instance`,
          actor: "Deplo",
          actorUserId: null,
          appId: null,
          databaseId: null,
          createdAt: nowIso(),
        }),
      );
    droppedEntries -= n;
  } catch (e) {
    console.error("[deplo] could not record the dropped-activity marker:", e);
  }
}

/**
 * The human behind an `actor` string, or null.
 */
export async function resolveActorUserId(
  actor: string,
): Promise<string | null> {
  try {
    const u = await getCurrentUser();
    if (u && (u.name === actor || u.username === actor)) return u.id;
  } catch {
    // No request scope - leave the row unattributed.
  }
  return null;
}
