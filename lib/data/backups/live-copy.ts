import "server-only";

import { and, desc, eq } from "drizzle-orm";

import { getDb } from "../../db/client";
import { activities } from "../../db/schema/control-plane/activity";
import { readAgent } from "../../infra/agent-client/connect";
import { loadTeamApp } from "../app-graph-load";
import { recordActivity } from "../activity";
import { getServerById } from "../servers/roster";

/** Why an App has no live copy to back up on its server, or null when it runs there or the server did not answer. */
export async function noLiveCopy(
  teamId: string,
  appId: string,
): Promise<string | null> {
  const app = await loadTeamApp(appId, teamId);
  if (!app) return null;
  try {
    const conn = await readAgent(app.serverId);
    try {
      const instances = await conn.listInstances(app.id, app.slug, "");
      if (instances.some((i) => i.running)) return null;
    } finally {
      conn.close();
    }
  } catch {
    return null;
  }
  const server = (await getServerById(app.serverId))?.name ?? "its server";
  return `Skipped a backup of ${app.name}: it is not running on ${server} right now, and a backup is only taken where it runs.`;
}

/** The same skip is said once, not at every scheduled run. */
export async function saySkippedOnce(
  teamId: string,
  appId: string,
  actor: string,
  message: string,
): Promise<void> {
  const [last] = await getDb()
    .select({ message: activities.message })
    .from(activities)
    .where(
      and(
        eq(activities.teamId, teamId),
        eq(activities.appId, appId),
        eq(activities.type, "backup"),
      ),
    )
    .orderBy(desc(activities.seq))
    .limit(1);
  if (last?.message === message) return;
  await recordActivity("backup", message, actor, appId, teamId, null, null);
}
