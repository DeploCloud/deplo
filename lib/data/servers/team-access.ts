import "server-only";

import { and, asc, eq, inArray } from "drizzle-orm";
import { getDb, type DrizzleClient, type DbTx } from "../../db/client";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import { backupDestination as destinationTable } from "../../db/schema/control-plane/backups";
import { databases as databasesTable } from "../../db/schema/control-plane/databases";
import { teams as teamsTable } from "../../db/schema/control-plane/identity";
import {
  serverTeams as serverTeamsTable,
  servers as serversTable,
} from "../../db/schema/control-plane/servers";
import { recordActivity } from "../activity";
import { teamAvatarUrl } from "../../avatar";
import { getServerById, requireAdminServer } from "./roster";
import type { Server } from "../../types/server";
import type { Team } from "../../types/team";

// getServerTeamIds lists the team ids a non-`all_teams` server is restricted to.
export async function getServerTeamIds(serverId: string): Promise<string[]> {
  const rows = await getDb()
    .select({ teamId: serverTeamsTable.teamId })
    .from(serverTeamsTable)
    .where(eq(serverTeamsTable.serverId, serverId));
  return rows.map((r) => r.teamId);
}

// getServerTeams lists the teams a server is granted to, with names.
export async function getServerTeams(serverId: string): Promise<Team[]> {
  const rows = await getDb()
    .select({
      id: teamsTable.id,
      name: teamsTable.name,
      slug: teamsTable.slug,
      plan: teamsTable.plan,
      image: teamsTable.image,
      createdAt: teamsTable.createdAt,
    })
    .from(serverTeamsTable)
    .innerJoin(teamsTable, eq(teamsTable.id, serverTeamsTable.teamId))
    .where(eq(serverTeamsTable.serverId, serverId))
    .orderBy(asc(teamsTable.name));
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    slug: r.slug,
    plan: r.plan as Team["plan"],
    avatarUrl: teamAvatarUrl(r.image),
    createdAt: r.createdAt,
  }));
}

// listAllServerTeamIds returns every server's granted team ids in one query.
export async function listAllServerTeamIds(): Promise<Map<string, string[]>> {
  const rows = await getDb()
    .select({
      serverId: serverTeamsTable.serverId,
      teamId: serverTeamsTable.teamId,
    })
    .from(serverTeamsTable);
  const map = new Map<string, string[]>();
  for (const r of rows) {
    const list = map.get(r.serverId);
    if (list) list.push(r.teamId);
    else map.set(r.serverId, [r.teamId]);
  }
  return map;
}

async function teamsWithWorkloadsOnServer(
  serverId: string,
  db: DrizzleClient | DbTx = getDb(),
): Promise<string[]> {
  const [projTeams, dbTeams] = await Promise.all([
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
      ...projTeams.map((r) => r.teamId),
      ...dbTeams.map((r) => r.teamId),
    ]),
  ];
}

async function teamNames(
  ids: string[],
  db: DrizzleClient | DbTx = getDb(),
): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select({ name: teamsTable.name })
    .from(teamsTable)
    .where(inArray(teamsTable.id, ids));
  return rows.map((r) => r.name);
}

// assertServerAccessibleTx re-asserts INSIDE a write transaction that a server is
// still targetable by a team, SHARE-locking the row so it serializes against a
// concurrent setServerTeams restrict (which takes the row's UPDATE lock).
export async function assertServerAccessibleTx(
  tx: DbTx,
  serverId: string,
  teamId: string,
): Promise<void> {
  const rows = await tx
    .select({ allTeams: serversTable.allTeams })
    .from(serversTable)
    .where(eq(serversTable.id, serverId))
    .for("share");
  if (!rows[0]) throw new Error("Server not found");
  if (rows[0].allTeams) return;
  const grant = await tx
    .select({ teamId: serverTeamsTable.teamId })
    .from(serverTeamsTable)
    .where(
      and(
        eq(serverTeamsTable.serverId, serverId),
        eq(serverTeamsTable.teamId, teamId),
      ),
    )
    .limit(1);
  if (!grant[0]) throw new Error("That server isn't available to this team.");
}

export interface SetServerTeamsInput {
  allTeams: boolean;
  // The granted teams when `allTeams` is false (ignored when it is true).
  teamIds: string[];
}

// setServerTeams sets a server's team access. Widening to `all_teams` never blocks.
export async function setServerTeams(
  id: string,
  input: SetServerTeamsInput,
): Promise<Server> {
  const { teamId, user, server } = await requireAdminServer(id);

  const allTeams = input.allTeams;
  const teamIds = allTeams ? [] : [...new Set(input.teamIds)];
  const selected = new Set(teamIds);

  await getDb().transaction(async (tx) => {
    // FOR UPDATE so a concurrent create that SHARE-locks it
    // (assertServerAccessibleTx) serializes against this restrict: the workload
    // check below then sees every workload committed before we won the lock.
    const locked = await tx
      .select({ id: serversTable.id })
      .from(serversTable)
      .where(eq(serversTable.id, id))
      .for("update");
    if (!locked[0]) throw new Error("Server not found");

    if (!allTeams) {
      // The chosen teams must exist (clean message instead of a raw FK error).
      if (teamIds.length > 0) {
        const known = await tx
          .select({ id: teamsTable.id })
          .from(teamsTable)
          .where(inArray(teamsTable.id, teamIds));
        if (known.length !== teamIds.length)
          throw new Error("One or more selected teams no longer exist.");
      }
      // A backup destination on its disk counts: its runs keep writing here.
      const using = await teamsWithWorkloadsOnServer(id, tx);
      const storing = (
        await tx
          .selectDistinct({ teamId: destinationTable.teamId })
          .from(destinationTable)
          .where(eq(destinationTable.serverId, id))
      ).map((r) => r.teamId);
      const losing = [...new Set([...using, ...storing])].filter(
        (t) => !selected.has(t),
      );
      if (losing.length > 0) {
        const names = await teamNames(losing, tx);
        throw new Error(
          `These teams still have apps, databases or backup destinations on this server: ${names.join(
            ", ",
          )}. Move or delete them before revoking the team's access.`,
        );
      }
    }

    await tx
      .update(serversTable)
      .set({ allTeams })
      .where(eq(serversTable.id, id));
    await tx.delete(serverTeamsTable).where(eq(serverTeamsTable.serverId, id));
    if (teamIds.length > 0)
      await tx
        .insert(serverTeamsTable)
        .values(teamIds.map((teamId) => ({ serverId: id, teamId })));
  });

  await recordActivity(
    "server",
    allTeams
      ? `Made server ${server.name} available to all teams`
      : `Set server ${server.name} access to ${teamIds.length} team${teamIds.length === 1 ? "" : "s"}`,
    user.name,
    null,
    teamId,
  );
  return (await getServerById(id))!;
}
