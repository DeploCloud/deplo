import "server-only";

import { eq } from "drizzle-orm";

import { getDb } from "../db/client";
import {
  apps as appsTable,
  databases as databasesTable,
  serverTeams,
  teams as teamsTable,
} from "../db/schema/control-plane";

/**
 * Who to tell about a SERVER-level or fleet-level event. Servers are the one
 * cross-team resource in Deplo, so "this host is offline" has no single owner: it
 * belongs to every team with something running on it.
 */

/** Distinct team ids that have at least one app OR database on this server. */
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
 * The teams an alert about `serverId` should reach: whoever runs something on the
 * host, else whoever was granted it, else the first team - a server added five
 * minutes ago that falls over mid-setup is when a new user most needs telling.
 *
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

/** Every team, for a condition that is genuinely instance-wide (a new release). */
export async function allTeamIds(): Promise<string[]> {
  const rows = await getDb().select({ id: teamsTable.id }).from(teamsTable);
  return rows.map((r) => r.id);
}

/** The oldest team - the last resort when an event belongs to nobody in particular. */
async function firstTeamId(): Promise<string[]> {
  const rows = await getDb()
    .select({ id: teamsTable.id })
    .from(teamsTable)
    .orderBy(teamsTable.createdAt)
    .limit(1);
  return rows[0] ? [rows[0].id] : [];
}
