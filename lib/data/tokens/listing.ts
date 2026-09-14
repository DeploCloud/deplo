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
  // What the token itself may do - its own set, before the creator clamp.
  capabilities: Capability[];
  // False ⇒ every team its creator belongs to, and everything in it.
  scoped: boolean;
  // Whole teams in the scope.
  teamIds: string[];
  // Whole projects in the scope.
  projectIds: string[];
  // Whole folders in the scope (their subtrees come with them).
  folderIds: string[];
  // Individually-named apps in the scope.
  appIds: string[];
  // Every team this token can act in, named - the scope lists flattened, or every
  // team the owner may use tokens in when it is not scoped.
  teamsReached: TokenTeam[];
  instanceAdmin: boolean;
  // The AI client this token was minted for, when it came from approving an OAuth
  // consent rather than from the tokens page.
  oauthClientName: string | null;
  // Talks MCP: minted by approving a consent, or a bearer token that has already
  // called `/api/mcp`.
  mcp: boolean;
  // When this credential stops working, or null for "never".
  expiresAt: string | null;
  expired: boolean;
  lastUsedAt: string | null;
  createdAt: string;
}

// The non-secret projection, never selects `token_hash` (relational-store PLAN §1 "Secrets").
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

// inCatalogOrder - a capability set in the order the catalogue lists them.
export function inCatalogOrder(caps: Capability[]): Capability[] {
  const set = new Set(caps);
  return ALL_CAPABILITIES.filter((c) => set.has(c));
}

// listTokens - YOUR tokens, and only yours. A bearer request sees just the token
// it is made with: a credential must not enumerate its owner's other credentials.
export async function listTokens(): Promise<ApiTokenDTO[]> {
  const user = await assertUser();
  const acting = currentIdentity()?.token;
  const rows = await getDb()
    .select({
      ...DTO_COLUMNS,
      oauthClientName: oauthClient.name,
      // Consumed by `mcp` and dropped: the id, not the joined name, because a
      // client row that has been deleted must not un-mark its connection.
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
  // Every junction in one query each, never per-token (PLAN §6 "batch-load").
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
  // An unscoped token reaches wherever its owner may use tokens, live.
  const everywhere = (await tokenReach(user.id)).map((t) => ({
    id: t.id,
    name: t.name,
  }));
  return rows.map(({ oauthClientId, mcpLastUsedAt, ...r }) => ({
    ...r,
    mcp: oauthClientId !== null || mcpLastUsedAt !== null,
    expired: r.expiresAt != null && Date.parse(r.expiresAt) <= now,
    // Chosen by the app at registration: free text, any length, shown in a badge.
    oauthClientName: r.oauthClientName?.slice(0, 80) ?? null,
    capabilities: inCatalogOrder((capsById.get(r.id) ?? []) as Capability[]),
    teamIds: teamsById.get(r.id) ?? [],
    projectIds: projectsById.get(r.id) ?? [],
    folderIds: foldersById.get(r.id) ?? [],
    appIds: appsById.get(r.id) ?? [],
    teamsReached: r.scoped ? (reachedByToken.get(r.id) ?? []) : everywhere,
  }));
}

// getToken - one token by id. Deliberately `listTokens().find(…)`, so there is
// exactly ONE place that assembles the DTO and its five junctions.
export async function getToken(id: string): Promise<ApiTokenDTO | null> {
  return (await listTokens()).find((t) => t.id === id) ?? null;
}
