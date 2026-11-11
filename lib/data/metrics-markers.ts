import "server-only";

import { and, asc, eq, gte, type SQL } from "drizzle-orm";

import { getDb } from "../db/client";
import { activities } from "../db/schema/control-plane/activity";
import { hasCapability, requireActiveTeamId } from "../membership";
import { CONTAINER_HISTORY_WINDOW_MS } from "../monitoring/container-history";
import { loadTeamApp } from "./app-graph-load";
import { loadDatabaseForTeam } from "./databases/rows";
import { hasAppCapability } from "./node-access";

export interface MetricsMarker {
  ts: number;
  label: string;
}

/** Where an App's charts jump for a reason: each move or failover inside the history window, in Activity's words. */
export async function getAppMetricsMarkers(
  appId: string,
): Promise<MetricsMarker[]> {
  const teamId = await requireActiveTeamId();
  if (!(await hasAppCapability(appId, "view_metrics"))) return [];
  const app = await loadTeamApp(appId, teamId);
  if (!app) return [];
  return markers(
    teamId,
    and(eq(activities.appId, app.id), eq(activities.type, "app")),
  );
}

/** The same for a database's charts. */
export async function getDatabaseMetricsMarkers(
  databaseId: string,
): Promise<MetricsMarker[]> {
  const teamId = await requireActiveTeamId();
  if (!(await hasCapability("view_metrics"))) return [];
  const db = await loadDatabaseForTeam(databaseId, teamId);
  if (!db) return [];
  return markers(
    teamId,
    and(eq(activities.databaseId, db.id), eq(activities.type, "database")),
  );
}

// The writer says which entries are a change of server (`server_change`); nothing here reads their wording.
async function markers(
  teamId: string,
  about: SQL | undefined,
): Promise<MetricsMarker[]> {
  const since = new Date(Date.now() - CONTAINER_HISTORY_WINDOW_MS);
  const rows = await getDb()
    .select({ message: activities.message, at: activities.createdAt })
    .from(activities)
    .where(
      and(
        eq(activities.teamId, teamId),
        about,
        eq(activities.serverChange, true),
        gte(activities.createdAt, since.toISOString()),
      ),
    )
    .orderBy(asc(activities.createdAt), asc(activities.seq));
  return rows.map((r) => ({ ts: Date.parse(r.at), label: r.message }));
}
