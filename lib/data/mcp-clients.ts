import "server-only";

// https://deplo.build/docs/guides/mcp-server

import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "../db/client";
import { memberships as membershipsTable } from "../db/schema/control-plane/access-control";
import { apiTokens } from "../db/schema/control-plane/api-tokens";
import { apps as appsTable } from "../db/schema/control-plane/apps";
import { teams as teamsTable } from "../db/schema/control-plane/identity";
import {
  folders as foldersTable,
  projects as projectsTable,
} from "../db/schema/control-plane/projects";
import { oauthClient, oauthConsent } from "../db/schema/auth";
import {
  membershipFor,
  requireActiveTeamId,
  requireTeamWide,
  teamsWhereUserHolds,
} from "../membership";
import { assertUser } from "../auth/current-user";
import type { Capability } from "../types/identity";
import { createToken } from "./tokens/mint";
import { tokensReaching } from "./tokens/reach";
import type { TokenScopeInput } from "./tokens/scope";
import { recordActivity } from "./activity";
import { listMyTeams } from "./teams";
import { requirePersonalSession } from "../auth/request-context";

// ADR-0021 §2: a connection is a PERSONAL token, and there is no second authorization path.

// ConsentClientDTO - a registered client, as the consent screen shows it.
export interface ConsentClientDTO {
  clientId: string;
  name: string;
  redirectOrigin: string | null;
  uri: string | null;
  icon: string | null;
}

// Names are clamped, not refused: createToken throws over 40 (MAX_NAME, lib/data/tokens/mint.ts).
const MAX_CLIENT_NAME = 40;

const CONSENT_FRESHNESS_MS = 5 * 60 * 1000;

async function assertFreshConsent(
  clientId: string,
  userId: string,
): Promise<void> {
  // The age is compared in JS on purpose: oauth_consent.created_at is a bare Better Auth
  // timestamp with no timezone, so comparing it against SQL now() skews this window silently.
  const row = (
    await getDb()
      .select({
        createdAt: oauthConsent.createdAt,
        updatedAt: oauthConsent.updatedAt,
      })
      .from(oauthConsent)
      .where(
        and(
          eq(oauthConsent.clientId, clientId),
          eq(oauthConsent.userId, userId),
        ),
      )
      .limit(1)
  )[0];
  const at = row?.updatedAt ?? row?.createdAt;
  if (!at || Date.now() - new Date(at).getTime() > CONSENT_FRESHNESS_MS)
    throw new Error(
      "That approval is not pending any more. Start the connection again from the app you were using.",
    );
}

// A named project, folder or app grants its team, so it passes the same per-team gate.
async function teamsOfNodes(input: TokenScopeInput): Promise<string[]> {
  const named = new Set([
    ...(input.projectIds ?? []),
    ...(input.folderIds ?? []),
    ...(input.appIds ?? []),
  ]);
  if (named.size === 0) return [];

  const db = getDb();
  const [projectRows, folderRows, appRows] = await Promise.all([
    input.projectIds?.length
      ? db
          .select({ teamId: projectsTable.teamId })
          .from(projectsTable)
          .where(inArray(projectsTable.id, input.projectIds))
      : [],
    input.folderIds?.length
      ? db
          .select({ teamId: foldersTable.teamId })
          .from(foldersTable)
          .where(inArray(foldersTable.id, input.folderIds))
      : [],
    input.appIds?.length
      ? db
          .select({ teamId: appsTable.teamId })
          .from(appsTable)
          .where(inArray(appsTable.id, input.appIds))
      : [],
  ]);
  const found = [...projectRows, ...folderRows, ...appRows];
  if (found.length !== named.size)
    throw new Error("One of those projects, folders or apps no longer exists.");
  return [...new Set(found.map((r) => r.teamId))];
}

async function assertMayConnect(teamId: string, userId: string): Promise<void> {
  const membership = await membershipFor(userId, teamId);
  if (!membership || !membership.capabilities.includes("manage_mcp"))
    throw new Error(
      "You can only connect an app to a team where you may connect AI agents.",
    );
  const row = (
    await getDb()
      .select({ enabled: teamsTable.mcpEnabled })
      .from(teamsTable)
      .where(eq(teamsTable.id, teamId))
      .limit(1)
  )[0];
  if (!row?.enabled)
    throw new Error(
      "One of those teams has turned off MCP access. An admin can switch it back on under Settings → MCP Server.",
    );
}

// listConnectableTeamIds - the teams this person may connect an AI client to right now.
export async function listConnectableTeamIds(): Promise<string[]> {
  const user = await assertUser();
  const rows = await getDb()
    .select({ id: teamsTable.id, enabled: teamsTable.mcpEnabled })
    .from(teamsTable)
    .innerJoin(
      membershipsTable,
      and(
        eq(membershipsTable.teamId, teamsTable.id),
        eq(membershipsTable.userId, user.id),
      ),
    );
  const ids = await Promise.all(
    rows.map(async (t) => {
      if (!t.enabled) return null;
      // An unmet two-factor policy throws here: the same "no" as missing the capability.
      const m = await membershipFor(user.id, t.id).catch(() => null);
      return m?.capabilities.includes("manage_mcp") ? t.id : null;
    }),
  );
  return ids.filter((id): id is string => id !== null);
}

function originOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

// getOAuthClientForConsent - the client a consent request names.
export async function getOAuthClientForConsent(
  clientId: string,
): Promise<ConsentClientDTO | null> {
  await assertUser();
  const row = (
    await getDb()
      .select({
        clientId: oauthClient.clientId,
        name: oauthClient.name,
        uri: oauthClient.uri,
        icon: oauthClient.icon,
        disabled: oauthClient.disabled,
        redirectUris: oauthClient.redirectUris,
      })
      .from(oauthClient)
      .where(eq(oauthClient.clientId, clientId))
      .limit(1)
  )[0];
  if (!row || row.disabled) return null;
  return {
    clientId: row.clientId,
    name: (row.name ?? "This app").slice(0, 80),
    redirectOrigin: originOf(row.redirectUris?.[0]),
    uri: row.uri ?? null,
    icon: row.icon ?? null,
  };
}

// AuthorizeMcpClientInput - `teamIds` names the teams this connection may work in.
export interface AuthorizeMcpClientInput extends TokenScopeInput {
  clientId: string;
  capabilities?: Capability[];
  expectedTeamId?: string;
}

// mintMcpConnection - every gate, then the mint; the raw secret is dropped on the floor.
export async function mintMcpConnection(
  input: AuthorizeMcpClientInput,
): Promise<{ tokenId: string }> {
  // A consent is a person's act; a token must not re-mint (and so revoke) one.
  requirePersonalSession("connecting an AI client");
  const { id: userId } = await assertUser();
  const teamId = await requireActiveTeamId();
  // A narrowed token must not be able to mint a whole-team connection.
  await requireTeamWide("connecting an AI client");

  if (input.expectedTeamId && input.expectedTeamId !== teamId)
    throw new Error(
      "The active team changed while you were approving. Check which team this connects, then try again.",
    );

  const client = await getOAuthClientForConsent(input.clientId);
  if (!client) throw new Error("That app is not registered with Deplo");

  await assertFreshConsent(input.clientId, userId);

  // Re-approving moves the connection: the old row goes, never widened in place.
  await getDb()
    .delete(apiTokens)
    .where(
      and(
        eq(apiTokens.oauthClientId, input.clientId),
        eq(apiTokens.userId, userId),
      ),
    );

  // Gated once per team; naming nothing means every team the person may connect to.
  const nodeTeams = await teamsOfNodes(input);
  const named = [...new Set([...(input.teamIds ?? []), ...nodeTeams])];
  for (const t of named) await assertMayConnect(t, userId);
  const granted = named.length ? named : await listConnectableTeamIds();
  if (granted.length === 0)
    throw new Error(
      "You can't connect AI agents to any of your teams. Ask a team admin for the permission, or to turn MCP on.",
    );

  const { token } = await createToken({
    name: client.name.slice(0, MAX_CLIENT_NAME),
    capabilities: input.capabilities,
    teamIds: input.teamIds,
    projectIds: input.projectIds,
    folderIds: input.folderIds,
    appIds: input.appIds,
  });

  await getDb()
    .update(apiTokens)
    .set({ oauthClientId: input.clientId })
    .where(eq(apiTokens.id, token.id));

  const actor = (await assertUser()).name;
  for (const t of granted)
    await recordActivity(
      "mcp",
      `Connected ${client.name} to this team over MCP`,
      actor,
      null,
      t,
    );

  return { tokenId: token.id };
}

// McpTeamDTO - a team as the MCP server names it to an agent.
export interface McpTeamDTO {
  id: string;
  name: string;
  slug: string;
  mcpEnabled: boolean;
  canConnect: boolean;
}

// listMcpTeams - every team the caller's credential can name, with whether MCP may act there.
export async function listMcpTeams(): Promise<McpTeamDTO[]> {
  const user = await assertUser();
  const mine = await listMyTeams();
  if (mine.length === 0) return [];
  const [allowed, switches] = await Promise.all([
    teamsWhereUserHolds(user.id, "manage_mcp"),
    getDb()
      .select({ id: teamsTable.id, enabled: teamsTable.mcpEnabled })
      .from(teamsTable)
      .where(
        inArray(
          teamsTable.id,
          mine.map((t) => t.id),
        ),
      ),
  ]);
  const enabled = new Map(switches.map((r) => [r.id, r.enabled]));
  return mine.map((t) => ({
    id: t.id,
    name: t.name,
    slug: t.slug,
    mcpEnabled: enabled.get(t.id) ?? false,
    canConnect: allowed.has(t.id),
  }));
}

// countMcpAgents - how many AI agents can act in the active team right now.
export async function countMcpAgents(): Promise<number> {
  const teamId = await requireActiveTeamId();
  return (await tokensReaching(teamId)).filter((t) => t.mcp).length;
}

// mcpTokenConnected - has YOUR token spoken MCP yet? A stranger's id answers false, never an error.
export async function mcpTokenConnected(tokenId: string): Promise<boolean> {
  const user = await assertUser();
  const rows = await getDb()
    .select({ mcpLastUsedAt: apiTokens.mcpLastUsedAt })
    .from(apiTokens)
    .where(and(eq(apiTokens.id, tokenId), eq(apiTokens.userId, user.id)))
    .limit(1);
  return !!rows[0]?.mcpLastUsedAt;
}
