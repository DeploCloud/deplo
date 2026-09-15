import "server-only";

import { and, eq, inArray } from "drizzle-orm";

import { getDb } from "../../db/client";
import {
  memberships as membershipsTable,
  membershipCapabilities as membershipCapabilitiesTable,
} from "../../db/schema/control-plane/access-control";
import {
  apiTokens,
  apiTokenTeams,
  apiTokenProjects,
  apiTokenFolders,
  apiTokenApps,
} from "../../db/schema/control-plane/api-tokens";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import { teams as teamsTable } from "../../db/schema/control-plane/identity";
import {
  folders as foldersTable,
  projects as projectsTable,
} from "../../db/schema/control-plane/projects";
import { teamsForUser, teamsWhereUserHolds } from "../../membership";
import type { Team } from "../../types/team";

async function tokenHoldersIn(teamId: string): Promise<Set<string>> {
  const rows = await getDb()
    .select({ userId: membershipsTable.userId })
    .from(membershipsTable)
    .innerJoin(
      membershipCapabilitiesTable,
      eq(membershipCapabilitiesTable.membershipId, membershipsTable.id),
    )
    .where(
      and(
        eq(membershipsTable.teamId, teamId),
        eq(membershipCapabilitiesTable.capability, "manage_tokens"),
      ),
    );
  return new Set(rows.map((r) => r.userId));
}

export async function tokensReaching(
  teamId: string,
): Promise<{ id: string; userId: string; mcp: boolean }[]> {
  const db = getDb();
  const holders = await tokenHoldersIn(teamId);
  if (holders.size === 0) return [];
  const [byTeam, byProject, byFolder, byApp] = await Promise.all([
    db
      .select({ id: apiTokenTeams.tokenId })
      .from(apiTokenTeams)
      .where(eq(apiTokenTeams.teamId, teamId)),
    db
      .select({ id: apiTokenProjects.tokenId })
      .from(apiTokenProjects)
      .innerJoin(
        projectsTable,
        eq(projectsTable.id, apiTokenProjects.projectId),
      )
      .where(eq(projectsTable.teamId, teamId)),
    db
      .select({ id: apiTokenFolders.tokenId })
      .from(apiTokenFolders)
      .innerJoin(foldersTable, eq(foldersTable.id, apiTokenFolders.folderId))
      .where(eq(foldersTable.teamId, teamId)),
    db
      .select({ id: apiTokenApps.tokenId })
      .from(apiTokenApps)
      .innerJoin(appsTable, eq(appsTable.id, apiTokenApps.appId))
      .where(eq(appsTable.teamId, teamId)),
  ]);
  const scopedIds = new Set(
    [...byTeam, ...byProject, ...byFolder, ...byApp].map((r) => r.id),
  );
  const rows = await db
    .select({
      id: apiTokens.id,
      userId: apiTokens.userId,
      scoped: apiTokens.scoped,
      oauthClientId: apiTokens.oauthClientId,
      mcpLastUsedAt: apiTokens.mcpLastUsedAt,
      expiresAt: apiTokens.expiresAt,
    })
    .from(apiTokens)
    .where(inArray(apiTokens.userId, [...holders]));
  const now = Date.now();
  return rows
    .filter(
      (r) =>
        (!r.scoped || scopedIds.has(r.id)) &&
        !(r.expiresAt && Date.parse(r.expiresAt) <= now),
    )
    .map((r) => ({
      id: r.id,
      userId: r.userId,
      mcp: r.oauthClientId !== null || r.mcpLastUsedAt !== null,
    }));
}

export async function tokenCountsByUser(
  teamId: string,
): Promise<Map<string, { tokens: number; agents: number }>> {
  const out = new Map<string, { tokens: number; agents: number }>();
  for (const t of await tokensReaching(teamId)) {
    const c = out.get(t.userId) ?? { tokens: 0, agents: 0 };
    c.tokens += 1;
    if (t.mcp) c.agents += 1;
    out.set(t.userId, c);
  }
  return out;
}

export async function tokenReach(userId: string): Promise<Team[]> {
  const holds = await teamsWhereUserHolds(userId, "manage_tokens");
  return (await teamsForUser(userId)).filter((t) => holds.has(t.id));
}

export interface TokenTeam {
  id: string;
  name: string;
}

export async function teamsReachedByTokens(
  ids: string[],
): Promise<Map<string, TokenTeam[]>> {
  const out = new Map<string, TokenTeam[]>();
  if (ids.length === 0) return out;
  const db = getDb();
  const [byTeam, byProject, byFolder, byApp] = await Promise.all([
    db
      .select({
        tokenId: apiTokenTeams.tokenId,
        id: teamsTable.id,
        name: teamsTable.name,
      })
      .from(apiTokenTeams)
      .innerJoin(teamsTable, eq(teamsTable.id, apiTokenTeams.teamId))
      .where(inArray(apiTokenTeams.tokenId, ids)),
    db
      .select({
        tokenId: apiTokenProjects.tokenId,
        id: teamsTable.id,
        name: teamsTable.name,
      })
      .from(apiTokenProjects)
      .innerJoin(
        projectsTable,
        eq(projectsTable.id, apiTokenProjects.projectId),
      )
      .innerJoin(teamsTable, eq(teamsTable.id, projectsTable.teamId))
      .where(inArray(apiTokenProjects.tokenId, ids)),
    db
      .select({
        tokenId: apiTokenFolders.tokenId,
        id: teamsTable.id,
        name: teamsTable.name,
      })
      .from(apiTokenFolders)
      .innerJoin(foldersTable, eq(foldersTable.id, apiTokenFolders.folderId))
      .innerJoin(teamsTable, eq(teamsTable.id, foldersTable.teamId))
      .where(inArray(apiTokenFolders.tokenId, ids)),
    db
      .select({
        tokenId: apiTokenApps.tokenId,
        id: teamsTable.id,
        name: teamsTable.name,
      })
      .from(apiTokenApps)
      .innerJoin(appsTable, eq(appsTable.id, apiTokenApps.appId))
      .innerJoin(teamsTable, eq(teamsTable.id, appsTable.teamId))
      .where(inArray(apiTokenApps.tokenId, ids)),
  ]);

  for (const r of [...byTeam, ...byProject, ...byFolder, ...byApp]) {
    const list = out.get(r.tokenId) ?? [];
    if (list.some((t) => t.id === r.id)) continue;
    out.set(r.tokenId, [...list, { id: r.id, name: r.name }]);
  }
  for (const list of out.values())
    list.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export async function namedTeams(ids: string[]): Promise<TokenTeam[]> {
  if (ids.length === 0) return [];
  const rows = await getDb()
    .select({ id: teamsTable.id, name: teamsTable.name })
    .from(teamsTable)
    .where(inArray(teamsTable.id, ids));
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}
