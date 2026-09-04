import "server-only";

// https://deplo.build/docs/guides/mcp-server

import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "../db/client";
import {
  apiTokens,
  apps as appsTable,
  folders as foldersTable,
  memberships as membershipsTable,
  projects as projectsTable,
  teams as teamsTable,
} from "../db/schema/control-plane";
import { oauthClient, oauthConsent } from "../db/schema/auth";
import {
  membershipFor,
  requireActiveTeamId,
  requireTeamWide,
  teamsWhereUserHolds,
} from "../membership";
import { assertUser } from "../auth";
import type { Capability } from "../types";
import { createToken, tokensReaching, type TokenScopeInput } from "./tokens";
import { recordActivity } from "./activity";
import { listMyTeams } from "./teams";

/**
 * Connecting an AI client over OAuth. That is ADR-0021 §2's "there is no second
 * authorization path, and there must never be one", kept true by not building
 * one. A connection is a PERSONAL token: it reaches the teams where its owner
 * may connect agents, and only its owner can see or revoke it.
 */

/** A registered client, as the consent screen shows it. */
export interface ConsentClientDTO {
  clientId: string;
  /** Free text the client chose for itself. Never show it without the origin. */
  name: string;
  /** The one thing a client cannot lie about: where it may be redirected back to. */
  redirectOrigin: string | null;
  uri: string | null;
  icon: string | null;
}

/** Names longer than this are clamped - `createToken` refuses over 40. */
const MAX_CLIENT_NAME = 40;

/** How recently the consent must have been given for a mint to follow it. */
const CONSENT_FRESHNESS_MS = 5 * 60 * 1000;

/**
 * Refuse to mint unless the person has JUST approved this client for real. It
 * could not be used immediately (the attacker still has no signed consent), but
 * the credential would exist.
 */
async function assertFreshConsent(
  clientId: string,
  userId: string,
): Promise<void> {
  // The age is compared in JS, and that is the CORRECT half of a real trap. So
  // comparing this row against `now()` in SQL is what breaks, and comparing it
  // against `Date.now()` is what works.
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

/**
 * The teams the named projects, folders and apps belong to. A connection reaches
 * every team its scope touches, not only the ones ticked as wholes, so a project
 * is a grant of its team, and has to pass the same per-team gate.
 */
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

/**
 * May this person let their AI client into THIS team?
 */
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

/**
 * The teams this person may connect an AI client to, right now: a member
 * holding `manage_mcp` in a team that has MCP on. What an unscoped connection
 * will act in, and what the consent screen names.
 */
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
      // An unmet two-factor policy THROWS in here rather than answering null,
      // and it is the same "no" as missing the capability.
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

/**
 * The client a consent request names.
 */
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

/**
 * `teamIds` names the teams this connection may work in.
 */
export interface AuthorizeMcpClientInput extends TokenScopeInput {
  clientId: string;
  capabilities?: Capability[];
  /**
   * The team the consent screen SHOWED, for the server to disagree with.
   */
  expectedTeamId?: string;
}

/**
 * Every gate, and the mint. The `raw` secret `createToken` returns is DROPPED on
 * the floor.
 */
export async function mintMcpConnection(
  input: AuthorizeMcpClientInput,
): Promise<{ tokenId: string }> {
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

  // Re-approving MOVES a connection rather than leaving two the owner cannot
  // tell apart, and never widens the previous token in place: the old row goes,
  // a new one is minted with exactly what this screen submitted.
  await getDb()
    .delete(apiTokens)
    .where(
      and(
        eq(apiTokens.oauthClientId, input.clientId),
        eq(apiTokens.userId, userId),
      ),
    );

  // Which teams this connection may work in, gated once PER TEAM, in that
  // team. Naming nothing means every team the person may connect agents to,
  // read live on each call - so there has to be at least one right now.
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

  // Outside any transaction, and the answer to "who let this AI client in", in
  // every team it can act in. Names the client and the approver, never a
  // secret: the raw token minted above is dropped on the floor.
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

/** A team as the MCP server names it to an agent. */
export interface McpTeamDTO {
  id: string;
  name: string;
  slug: string;
  /** The team's own switch. */
  mcpEnabled: boolean;
  /** Whether the caller holds `manage_mcp` there. */
  canConnect: boolean;
}

/**
 * Every team the caller's credential can name, with whether MCP may act there:
 * the team's switch AND the caller's own `manage_mcp`. Both false-able, both
 * listed, so an agent can say WHY a team is off limits instead of guessing.
 */
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

/**
 * How many AI agents can act in the active team right now - every member's,
 * as a number and nothing more. A team never sees another person's credential;
 * it sees that agents are here, and takes them away through the member.
 */
export async function countMcpAgents(): Promise<number> {
  const teamId = await requireActiveTeamId();
  return (await tokensReaching(teamId)).filter((t) => t.mcp).length;
}

/**
 * Has YOUR token spoken MCP yet? Deliberately a boolean: somebody else's id
 * answers `false` rather than an error that confirms the row exists.
 */
export async function mcpTokenConnected(tokenId: string): Promise<boolean> {
  const user = await assertUser();
  const rows = await getDb()
    .select({ mcpLastUsedAt: apiTokens.mcpLastUsedAt })
    .from(apiTokens)
    .where(and(eq(apiTokens.id, tokenId), eq(apiTokens.userId, user.id)))
    .limit(1);
  return !!rows[0]?.mcpLastUsedAt;
}
