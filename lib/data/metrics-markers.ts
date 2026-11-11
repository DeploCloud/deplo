import "server-only";

import { and, asc, eq, gte } from "drizzle-orm";

import { getDb } from "../db/client";
import { activities } from "../db/schema/control-plane/activity";
import { requireActiveTeamId } from "../membership";
import { CONTAINER_HISTORY_WINDOW_MS } from "../monitoring/container-history";
import { loadTeamApp } from "./app-graph-load";
import { hasAppCapability } from "./node-access";

export interface MetricsMarker {
  ts: number;
  label: string;
}

// The Activity entries that say an App changed servers: a move, a failover, a replica started elsewhere, a
// failover that restored a backup. "Moved web's data from a to b" ends a move this already marked.
const CHANGED_SERVERS =
  /^(Moved (?!.*'s data from )|Started a replica of |Restored .+ on .+ from (its latest backup|the backup of ))/;

/** Where an App's charts jump for a reason: each move or failover inside the history window, in Activity's words. */
export async function getAppMetricsMarkers(
  appId: string,
): Promise<MetricsMarker[]> {
  const teamId = await requireActiveTeamId();
  if (!(await hasAppCapability(appId, "view_metrics"))) return [];
  const app = await loadTeamApp(appId, teamId);
  if (!app) return [];
  const since = new Date(Date.now() - CONTAINER_HISTORY_WINDOW_MS);
  const rows = await getDb()
    .select({ message: activities.message, at: activities.createdAt })
    .from(activities)
    .where(
      and(
        eq(activities.teamId, teamId),
        eq(activities.appId, app.id),
        eq(activities.type, "app"),
        gte(activities.createdAt, since.toISOString()),
      ),
    )
    .orderBy(asc(activities.createdAt), asc(activities.seq));
  return rows
    .filter((r) => CHANGED_SERVERS.test(r.message))
    .map((r) => ({ ts: Date.parse(r.at), label: r.message }));
}
