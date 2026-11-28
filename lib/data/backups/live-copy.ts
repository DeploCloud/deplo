import "server-only";

import { and, desc, eq } from "drizzle-orm";

import { getDb } from "../../db/client";
import { activities } from "../../db/schema/control-plane/activity";
import { databases as databasesTable } from "../../db/schema/control-plane/databases";
import { readAgent } from "../../infra/agent-client/connect";
import { loadTeamApp } from "../app-graph-load";
import { recordActivity } from "../activity";
import { getServerById } from "../servers/roster";
import type { BackupTargetKind } from "../../types/backup";

/** What its server said: `runs` only when it answered that the target runs there; `skip` says why there is no live copy. */
export type LiveCopy = { runs: boolean; skip: string | null; server: string };

const serverName = async (id: string) =>
  (await getServerById(id))?.name ?? "its server";

export async function liveCopy(
  teamId: string,
  kind: BackupTargetKind,
  id: string,
): Promise<LiveCopy> {
  const target =
    kind === "app" ? await appTarget(teamId, id) : await dbTarget(teamId, id);
  if (!target) return { runs: false, skip: null, server: "" };
  try {
    const conn = await readAgent(target.serverId);
    try {
      const instances = await conn.listInstances(target.id, target.slug, "");
      if (instances.some((i) => i.running))
        return { runs: true, skip: null, server: target.serverId };
    } finally {
      conn.close();
    }
  } catch {
    return { runs: false, skip: null, server: target.serverId };
  }
  const server = await serverName(target.serverId);
  return {
    runs: false,
    skip: `Skipped a backup of ${target.label}: it is not running on ${server} right now, and a backup is only taken where it runs.`,
    server: target.serverId,
  };
}

async function appTarget(teamId: string, id: string) {
  const app = await loadTeamApp(id, teamId);
  return app && { ...app, label: app.name };
}

async function dbTarget(teamId: string, id: string) {
  const [d] = await getDb()
    .select({
      id: databasesTable.id,
      serverId: databasesTable.serverId,
      name: databasesTable.name,
      slug: databasesTable.host,
    })
    .from(databasesTable)
    .where(and(eq(databasesTable.id, id), eq(databasesTable.teamId, teamId)))
    .limit(1);
  return d && { ...d, label: `database ${d.name}` };
}

export const nothingYetMessage = async (label: string, serverId: string) =>
  `Nothing to back up yet for ${label}: its data on ${await serverName(serverId)} holds no file so far, so no backup was kept.`;

/** The same skip is said once, not at every scheduled run. */
export async function saySkippedOnce(
  teamId: string,
  target: { appId: string | null; databaseId: string | null },
  actor: string,
  message: string,
): Promise<void> {
  const [last] = await getDb()
    .select({ message: activities.message })
    .from(activities)
    .where(
      and(
        eq(activities.teamId, teamId),
        target.databaseId
          ? eq(activities.databaseId, target.databaseId)
          : eq(activities.appId, target.appId ?? ""),
        eq(activities.type, "backup"),
      ),
    )
    .orderBy(desc(activities.seq))
    .limit(1);
  if (last?.message === message) return;
  await recordActivity(
    "backup",
    message,
    actor,
    target.appId,
    teamId,
    null,
    target.databaseId,
  );
}
