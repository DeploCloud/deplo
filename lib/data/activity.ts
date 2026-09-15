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

export const ACTOR_SYSTEM = "system";

export interface ActivityFilter {
  actorUserIds?: string[];
  types?: ActivityType[];
  from?: string;
  to?: string;
  resourceIds?: string[];
  cursor?: { createdAt: string; seq: number };
}

export async function listActivity(
  limit = 20,
  filter: ActivityFilter = {},
): Promise<Activity[]> {
  return queryActivity(Math.min(Math.max(1, limit), 200), filter);
}

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
  if (!(await hasCapability("view_activity"))) return [];
  const rows = await getDb()
    .select()
    .from(activitiesTable)
    .where(
      and(
        eq(activitiesTable.teamId, teamId),
        ...activityFilterWhere(teamId, filter),
        await scopedActivityWhere(),
      ),
    )
    .orderBy(desc(activitiesTable.createdAt), desc(activitiesTable.seq))
    .limit(limit);
  const authors = await loadUserIdentities(rows.map((r) => r.actorUserId));
  return rows.map((row) => ({
    ...assembleActivity(row),
    actorUser: authorOf(row.actorUserId, authors),
  }));
}

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

export async function activityMonths(
  filter: ActivityFilter = {},
  tz = "UTC",
): Promise<{ month: string; count: number }[]> {
  const teamId = await requireActiveTeamId();
  if (!(await hasCapability("view_activity"))) return [];
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

export type ActivityActor = string | { name: string; provider: string };

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

export async function resolveActorUserId(
  actor: string,
): Promise<string | null> {
  try {
    const u = await getCurrentUser();
    if (u && (u.name === actor || u.username === actor)) return u.id;
  } catch {}
  return null;
}
