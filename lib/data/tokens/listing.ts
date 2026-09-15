import "server-only";

import { and, desc, eq, inArray } from "drizzle-orm";

import { getDb } from "../../db/client";
import {
  apiTokens,
  apiTokenCapabilities,
  apiTokenTeams,
  apiTokenProjects,
  apiTokenFolders,
  apiTokenApps,
} from "../../db/schema/control-plane/api-tokens";
import { oauthClient } from "../../db/schema/auth";
import { assertUser } from "../../auth/current-user";
import { ALL_CAPABILITIES, type Capability } from "../../types/identity";
import { currentIdentity } from "../../auth/request-context";
import { teamsReachedByTokens, tokenReach, type TokenTeam } from "./reach";

export interface ApiTokenDTO {
  id: string;
  name: string;
  prefix: string;
  capabilities: Capability[];
  scoped: boolean;
  teamIds: string[];
  projectIds: string[];
  folderIds: string[];
  appIds: string[];
  teamsReached: TokenTeam[];
  instanceAdmin: boolean;
  oauthClientName: string | null;
  mcp: boolean;
  expiresAt: string | null;
  expired: boolean;
  lastUsedAt: string | null;
  createdAt: string;
}

const DTO_COLUMNS = {
  id: apiTokens.id,
  name: apiTokens.name,
  prefix: apiTokens.prefix,
  scoped: apiTokens.scoped,
  instanceAdmin: apiTokens.instanceAdmin,
  expiresAt: apiTokens.expiresAt,
  lastUsedAt: apiTokens.lastUsedAt,
  createdAt: apiTokens.createdAt,
} as const;

export function inCatalogOrder(caps: Capability[]): Capability[] {
  const set = new Set(caps);
  return ALL_CAPABILITIES.filter((c) => set.has(c));
}

export async function listTokens(): Promise<ApiTokenDTO[]> {
  const user = await assertUser();
  const acting = currentIdentity()?.token;
  const rows = await getDb()
    .select({
      ...DTO_COLUMNS,
      oauthClientName: oauthClient.name,
      oauthClientId: apiTokens.oauthClientId,
      mcpLastUsedAt: apiTokens.mcpLastUsedAt,
    })
    .from(apiTokens)
    .leftJoin(oauthClient, eq(oauthClient.clientId, apiTokens.oauthClientId))
    .where(
      acting
        ? and(eq(apiTokens.userId, user.id), eq(apiTokens.id, acting.id))
        : eq(apiTokens.userId, user.id),
    )
    .orderBy(desc(apiTokens.createdAt));
  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.id);
  const [reachedByToken, caps, teamRows, projRows, folderRows, appRows] =
    await Promise.all([
      teamsReachedByTokens(ids),
      getDb()
        .select({
          tokenId: apiTokenCapabilities.tokenId,
          value: apiTokenCapabilities.capability,
        })
        .from(apiTokenCapabilities)
        .where(inArray(apiTokenCapabilities.tokenId, ids)),
      getDb()
        .select({ tokenId: apiTokenTeams.tokenId, value: apiTokenTeams.teamId })
        .from(apiTokenTeams)
        .where(inArray(apiTokenTeams.tokenId, ids)),
      getDb()
        .select({
          tokenId: apiTokenProjects.tokenId,
          value: apiTokenProjects.projectId,
        })
        .from(apiTokenProjects)
        .where(inArray(apiTokenProjects.tokenId, ids)),
      getDb()
        .select({
          tokenId: apiTokenFolders.tokenId,
          value: apiTokenFolders.folderId,
        })
        .from(apiTokenFolders)
        .where(inArray(apiTokenFolders.tokenId, ids)),
      getDb()
        .select({ tokenId: apiTokenApps.tokenId, value: apiTokenApps.appId })
        .from(apiTokenApps)
        .where(inArray(apiTokenApps.tokenId, ids)),
    ]);
  const group = (rows: { tokenId: string; value: string }[]) => {
    const m = new Map<string, string[]>();
    for (const r of rows)
      m.set(r.tokenId, [...(m.get(r.tokenId) ?? []), r.value]);
    return m;
  };
  const capsById = group(caps);
  const teamsById = group(teamRows);
  const projectsById = group(projRows);
  const foldersById = group(folderRows);
  const appsById = group(appRows);

  const now = Date.now();
  const everywhere = (await tokenReach(user.id)).map((t) => ({
    id: t.id,
    name: t.name,
  }));
  return rows.map(({ oauthClientId, mcpLastUsedAt, ...r }) => ({
    ...r,
    mcp: oauthClientId !== null || mcpLastUsedAt !== null,
    expired: r.expiresAt != null && Date.parse(r.expiresAt) <= now,
    oauthClientName: r.oauthClientName?.slice(0, 80) ?? null,
    capabilities: inCatalogOrder((capsById.get(r.id) ?? []) as Capability[]),
    teamIds: teamsById.get(r.id) ?? [],
    projectIds: projectsById.get(r.id) ?? [],
    folderIds: foldersById.get(r.id) ?? [],
    appIds: appsById.get(r.id) ?? [],
    teamsReached: r.scoped ? (reachedByToken.get(r.id) ?? []) : everywhere,
  }));
}

export async function getToken(id: string): Promise<ApiTokenDTO | null> {
  return (await listTokens()).find((t) => t.id === id) ?? null;
}
