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
import { activities as activitiesTable } from "../db/schema/control-plane/activity";
import { apps as appsTable } from "../db/schema/control-plane/apps";
import { databases as databasesTable } from "../db/schema/control-plane/databases";
import { teams } from "../db/schema/control-plane/identity";
import { assembleActivity, activityToRow } from "./infra-rows";
import { authorOf, loadUserIdentities } from "./user-identity";
import { getCurrentUser } from "../auth/current-user";
import { newId, nowIso } from "../ids";
import {
  currentMemberScope,
  hasCapability,
  requireActiveTeamId,
} from "../membership";
import { appScopeWhere } from "./app-graph-load";
import { narrowedScope } from "../auth/request-context";
import { dispatchAlert } from "../notify/dispatch";
import type { Activity, ActivityType } from "../types/activity";
import type { VarAuthor } from "../types/identity";
import type { AlertKey } from "../types/notification";

// ACTOR_SYSTEM - the actor of rows with no human behind them (actor_user_id IS NULL).
export const ACTOR_SYSTEM = "system";

// ActivityFilter - how the feed is narrowed; it never widens what the caller reaches.
export interface ActivityFilter {
  actorUserIds?: string[];
  types?: ActivityType[];
  from?: string;
  to?: string;
  resourceIds?: string[];
  cursor?: { createdAt: string; seq: number };
}

// listActivity - the active team's trail, newest-first, with the LIMIT pushed into SQL.
export async function listActivity(
  limit = 20,
  filter: ActivityFilter = {},
): Promise<Activity[]> {
  return queryActivity(Math.min(Math.max(1, limit), 200), filter);
}

// Arrays are spelled out: inArray(col, []) has changed behaviour across Drizzle versions.
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
    // The ROW form is the one Postgres takes as an Index Cond on the keyset index.
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
  // Soft (empty) rather than a throw: this feeds the Overview card and the Activity
  // page, which both already render "nothing yet".
  if (!(await hasCapability("view_activity"))) return [];
  const rows = await getDb()
    .select()
    .from(activitiesTable)
    .where(
      and(
        eq(activitiesTable.teamId, teamId),
        ...activityFilterWhere(teamId, filter),
        // A narrowed token reaches only its own apps; team-level rows drop out too.
        await scopedActivityWhere(),
      ),
    )
    // seq breaks a same-timestamp tie; the (team_id, created_at DESC, seq DESC) index serves it.
    .orderBy(desc(activitiesTable.createdAt), desc(activitiesTable.seq))
    .limit(limit);
  const authors = await loadUserIdentities(rows.map((r) => r.actorUserId));
  return rows.map((row) => ({
    ...assembleActivity(row),
    actorUser: authorOf(row.actorUserId, authors),
  }));
}

// Databases are not folder/project-scoped, so a narrowed caller reaches no database row.
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
    // Spelled out: inArray(col, []) has changed behaviour across Drizzle versions.
    clauses.push(
      alt.length === 0 ? sql`false` : alt.length === 1 ? alt[0] : or(...alt)!,
    );
  }
  return inArray(
    activitiesTable.appId,
    getDb()
      .select({ id: appsTable.id })
      .from(appsTable)
      .where(clauses.length === 1 ? clauses[0] : and(...clauses)),
  );
}

// activityMonths - events per month for the feed's headers, filtered minus the cursor.
export async function activityMonths(
  filter: ActivityFilter = {},
  tz = "UTC",
): Promise<{ month: string; count: number }[]> {
  const teamId = await requireActiveTeamId();
  if (!(await hasCapability("view_activity"))) return [];
  // to_char, not date_trunc: a raw timestamptz comes back in the SESSION's TimeZone.
  // GROUP BY takes the ORDINAL - Drizzle renders the same sql object qualified there.
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

// activityCountsByType - events per kind in the window, same filters and scope as the feed.
export async function activityCountsByType(
  filter: ActivityFilter = {},
): Promise<{ type: ActivityType; count: number }[]> {
  const teamId = await requireActiveTeamId();
  if (!(await hasCapability("view_activity"))) return [];
  const rows = await getDb()
    .select({
      type: activitiesTable.type,
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
    .orderBy(sql`2 desc, 1 asc`);
  return rows.map((r) => ({ type: r.type as ActivityType, count: r.count }));
}

// activityCountsByActor - the same counts per person, non-humans in the ACTOR_SYSTEM bucket.
export async function activityCountsByActor(
  filter: ActivityFilter = {},
): Promise<{ actorUserId: string; count: number }[]> {
  const teamId = await requireActiveTeamId();
  if (!(await hasCapability("view_activity"))) return [];
  const actor = sql<string>`coalesce(${activitiesTable.actorUserId}, ${ACTOR_SYSTEM})`;
  return getDb()
    .select({
      actorUserId: actor.as("actor_user_id"),
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
    .orderBy(sql`2 desc, 1 asc`);
}

// listActivityActors - everyone in this team's trail, read off the trail so leavers stay pickable.
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
  return out.sort((a, b) =>
    a.value === ACTOR_SYSTEM
      ? 1
      : b.value === ACTOR_SYSTEM
        ? -1
        : a.label.localeCompare(b.label),
  );
}

// ActivityActor - who acted: a name, or an account on a git host when a webhook did it.
export type ActivityActor = string | { name: string; provider: string };

// recordActivity - record an event; falls back to the first team so no row is team-less.
export async function recordActivity(
  type: ActivityType,
  message: string,
  actor: ActivityActor,
  appId: string | null = null,
  teamId: string | null = null,
  alert: AlertKey | null = null,
  databaseId: string | null = null,
): Promise<void> {
  const name = typeof actor === "string" ? actor : actor.name;
  const provider = typeof actor === "string" ? null : actor.provider;
  // PLAN §1(c): an audit insert must never roll back the user's action - fire-and-forget.
  let written = false;
  try {
    const db = getDb();
    let resolved = teamId;
    if (!resolved && appId) {
      const { loadAppGraph } = await import("./app-graph-load");
      resolved = (await loadAppGraph(appId))?.teamId ?? null;
    }
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
      actor: name,
      actorUserId: provider ? null : await resolveActorUserId(name),
      actorUser: null,
      actorProvider: provider,
      appId,
      databaseId,
      createdAt: nowIso(),
    };
    await insertActivityRow(activity);
    written = true;
    // After the row it follows, so the marker cannot be what fails and hides the entry.
    await flushDroppedMarker(resolved);
    if (alert)
      dispatchAlert({
        teamId: resolved,
        key: alert,
        title: message,
        body: `By ${name}.`,
        path: "/activity",
      });
  } catch (e) {
    if (!written) droppedEntries += 1;
    console.error("[deplo] recordActivity failed:", e);
  }
}

let droppedEntries = 0;

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
          actorProvider: null,
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

// resolveActorUserId - the human behind an actor string, or null.
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
