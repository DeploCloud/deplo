import "server-only";

import { eq } from "drizzle-orm";

import { getDb } from "../db/client";
import { apps as appsTable } from "../db/schema/control-plane/apps";
import { databases as databasesTable } from "../db/schema/control-plane/databases";
import { teams as teamsTable } from "../db/schema/control-plane/identity";
import { serverTeams } from "../db/schema/control-plane/servers";

async function teamsWithWorkloads(serverId: string): Promise<string[]> {
  const db = getDb();
  const [appTeams, dbTeams] = await Promise.all([
    db
      .selectDistinct({ teamId: appsTable.teamId })
      .from(appsTable)
      .where(eq(appsTable.serverId, serverId)),
    db
      .selectDistinct({ teamId: databasesTable.teamId })
      .from(databasesTable)
      .where(eq(databasesTable.serverId, serverId)),
  ]);
  return [
    ...new Set([
      ...appTeams.map((r) => r.teamId),
      ...dbTeams.map((r) => r.teamId),
    ]),
  ];
}

/**
 * ponytail: a shared server nobody uses alerts the FIRST team, not all of them.
 * Per-team server subscriptions the day somebody asks.
 */
export async function teamsForServerAlerts(
  serverId: string,
): Promise<string[]> {
  const withWork = await teamsWithWorkloads(serverId);
  if (withWork.length > 0) return withWork;

  const granted = await getDb()
    .select({ teamId: serverTeams.teamId })
    .from(serverTeams)
    .where(eq(serverTeams.serverId, serverId));
  if (granted.length > 0) return granted.map((r) => r.teamId);

  return firstTeamId();
}

export async function allTeamIds(): Promise<string[]> {
  const rows = await getDb().select({ id: teamsTable.id }).from(teamsTable);
  return rows.map((r) => r.id);
}

async function firstTeamId(): Promise<string[]> {
  const rows = await getDb()
    .select({ id: teamsTable.id })
    .from(teamsTable)
    .orderBy(teamsTable.createdAt)
    .limit(1);
  return rows[0] ? [rows[0].id] : [];
}
