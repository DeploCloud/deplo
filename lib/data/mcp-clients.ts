import "server-only";

// https://deplo.build/docs/advanced/mcp-server

import { and, desc, eq, inArray, isNotNull, or } from "drizzle-orm";
import { getDb } from "../db/client";
import {
  apiTokenCapabilities,
  apiTokens,
  apps as appsTable,
  folders as foldersTable,
  memberships as membershipsTable,
  projects as projectsTable,
  teams as teamsTable,
  users as usersTable,
} from "../db/schema/control-plane";
import { oauthClient, oauthConsent } from "../db/schema/auth";
import {
  membershipFor,
  requireActiveTeamId,
  requireCapability,
  requireTeamWide,
} from "../membership";
import { assertUser } from "../auth";
import { ALL_CAPABILITIES, type Capability } from "../types";
import { createToken, tokenIdsReaching, type TokenScopeInput } from "./tokens";
import { getMcpSettings } from "./mcp-settings";
import { recordActivity } from "./activity";

/**
 * Connecting an AI client to a team, over OAuth. That is ADR-0021 §2's "there is
 * no second authorization path, and there must never be one", kept true by not
 * building one.
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

/** A live connection, as Settings → MCP lists it. */
export interface McpConnectionDTO {
  /**
   * The `api_tokens` id - Revoke goes through `revokeToken`, one lever, and it
   * ends the credential: the client is disconnected from every team the same
   * consent approved, not only this one.
   */
  id: string;
  /**
   * How it got in. Two shapes, ONE list, because the question the screen answers
   * is "what can act in this team over MCP" and a split would answer it twice.
   */
  kind: "web" | "token";
  clientName: string;
  clientUri: string | null;
  clientIcon: string | null;
  redirectOrigin: string | null;
  username: string | null;
  /** The team it is MANAGED from — which may not be the team reading this list. */
  teamId: string;
  teamName: string;
  capabilities: Capability[];
  /** Any authenticated use — GraphQL and the deploy hook included. */
  lastUsedAt: string | null;
  /** The last MCP call specifically. What makes a `token` row appear at all. */
  mcpLastUsedAt: string | null;
  /** Past its expiry: still listed, so the screen can say WHY it stopped. */
  expired: boolean;
  createdAt: string;
}

/** Names longer than this are clamped — `createToken` refuses over 40. */
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
 * every team its scope touches, not only the ones ticked as wholes — so a project
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
 * May this person let an AI client into THIS team?
 */
async function assertMayConnect(teamId: string, userId: string): Promise<void> {
  const membership = await membershipFor(userId, teamId);
  if (!membership || !membership.capabilities.includes("manage_mcp"))
    throw new Error(
      "You can only connect an app to a team where you may manage MCP access.",
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
 * The teams this person may connect an AI client to, right now. A team the person
 * may NOT grant stays unticked, because ticking it would turn Authorize into a
 * refusal.
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
  // Runs `membershipFor`, so an unmet two-factor policy refuses here.
  const { teamId, userId } = await requireCapability("manage_mcp");
  // A narrowed token must not be able to mint a whole-team connection.
  await requireTeamWide("connecting an AI client");

  if (input.expectedTeamId && input.expectedTeamId !== teamId)
    throw new Error(
      "The active team changed while you were approving. Check which team this connects, then try again.",
    );

  if (!(await getMcpSettings()).enabled)
    throw new Error(
      "This team has turned off MCP access. An admin can switch it back on under Settings → MCP Server.",
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

  // Which teams this connection may work in — and the gate runs once PER TEAM, in
  // that team. The team being connected FROM is always included: you cannot connect a
  // client from a team and leave that team out.
  const nodeTeams = await teamsOfNodes(input);
  const granted = [
    ...new Set([teamId, ...(input.teamIds ?? []), ...nodeTeams]),
  ];
  for (const t of granted) await assertMayConnect(t, userId);

  const namesNothing =
    !input.teamIds?.length &&
    !input.projectIds?.length &&
    !input.folderIds?.length &&
    !input.appIds?.length;

  const { token } = await createToken({
    name: client.name.slice(0, MAX_CLIENT_NAME),
    capabilities: input.capabilities,
    // Ticking nothing means "the team I am connecting from, all of it".
    teamIds: namesNothing ? [teamId] : input.teamIds,
    projectIds: input.projectIds,
    folderIds: input.folderIds,
    appIds: input.appIds,
  });

  await getDb()
    .update(apiTokens)
    .set({ oauthClientId: input.clientId })
    .where(eq(apiTokens.id, token.id));

  // Outside any transaction, and the answer to "who let this AI client in".
  // Names the client and the approver, never a secret: the raw token minted
  // above is dropped on the floor and never travels anywhere.
  await recordActivity(
    "mcp",
    `Connected ${client.name} to this team over MCP`,
    (await assertUser()).name,
    null,
    teamId,
  );

  return { tokenId: token.id };
}

/**
 * The AI clients connected to the active team. An OAuth connector has an
 * `oauth_client_id` from the moment it is approved, so it is listed before it has
 * ever called anything - approving it IS the connection.
 */
export async function listMcpConnections(): Promise<McpConnectionDTO[]> {
  const teamId = await requireActiveTeamId();
  await requireTeamWide("connected MCP clients");

  // Every connection that can ACT here, not the ones minted here — the same rule
  // `listTokens` follows, and for its reason: a team that cannot see a credential
  // operating inside it cannot revoke it either.
  const reaching = await tokenIdsReaching(teamId);
  if (reaching.size === 0) return [];

  const rows = await getDb()
    .select({
      id: apiTokens.id,
      teamId: apiTokens.teamId,
      teamName: teamsTable.name,
      username: usersTable.username,
      tokenName: apiTokens.name,
      oauthClientId: apiTokens.oauthClientId,
      lastUsedAt: apiTokens.lastUsedAt,
      mcpLastUsedAt: apiTokens.mcpLastUsedAt,
      expiresAt: apiTokens.expiresAt,
      createdAt: apiTokens.createdAt,
      clientName: oauthClient.name,
      clientUri: oauthClient.uri,
      clientIcon: oauthClient.icon,
      redirectUris: oauthClient.redirectUris,
    })
    .from(apiTokens)
    // LEFT, not inner: a bearer token driving Claude Code has no registered
    // client row and used to be dropped by the join before the WHERE could
    // even consider it.
    .leftJoin(oauthClient, eq(oauthClient.clientId, apiTokens.oauthClientId))
    .leftJoin(usersTable, eq(usersTable.id, apiTokens.userId))
    .leftJoin(teamsTable, eq(teamsTable.id, apiTokens.teamId))
    .where(
      and(
        inArray(apiTokens.id, [...reaching]),
        or(
          isNotNull(apiTokens.oauthClientId),
          isNotNull(apiTokens.mcpLastUsedAt),
        ),
      ),
    )
    .orderBy(desc(apiTokens.createdAt));
  if (rows.length === 0) return [];

  // One query for every connection's capabilities, never one per row.
  const caps = await getDb()
    .select({
      tokenId: apiTokenCapabilities.tokenId,
      capability: apiTokenCapabilities.capability,
    })
    .from(apiTokenCapabilities)
    .where(
      inArray(
        apiTokenCapabilities.tokenId,
        rows.map((r) => r.id),
      ),
    );
  const byToken = new Map<string, Set<string>>(
    rows.map((r) => [r.id, new Set<string>()]),
  );
  for (const c of caps) byToken.get(c.tokenId)?.add(c.capability);

  const now = Date.now();
  return rows.map((r) => {
    const web = r.oauthClientId !== null;
    return {
      id: r.id,
      kind: web ? ("web" as const) : ("token" as const),
      // A web client's name is attacker-chosen free text of any length, so it is
      // bounded before it reaches a screen. A bearer token's name is the one its
      // minter typed, already capped at 40 by `createToken`.
      clientName: web
        ? (r.clientName ?? "Unknown app").slice(0, 80)
        : r.tokenName,
      clientUri: r.clientUri ?? null,
      clientIcon: r.clientIcon ?? null,
      redirectOrigin: originOf(r.redirectUris?.[0]),
      username: r.username ?? null,
      teamId: r.teamId,
      teamName: r.teamName ?? "",
      // Read live from the junction, never a copy taken at approval time: if the
      // token is edited, this list must show what it can do NOW or the revocation
      // screen is lying about what it is revoking.
      capabilities: ALL_CAPABILITIES.filter((c) => byToken.get(r.id)?.has(c)),
      lastUsedAt: r.lastUsedAt,
      mcpLastUsedAt: r.mcpLastUsedAt,
      // Same comparison `identityForTokenRow` fails closed on, so the badge and
      // the refusal can never disagree.
      expired: !!r.expiresAt && Date.parse(r.expiresAt) <= now,
      createdAt: r.createdAt,
    };
  });
}

/**
 * Has this token spoken MCP yet? It is deliberately a boolean and not a timestamp
 * — the caller is asking one question, and an id from another team must answer it
 * with `false` rather than with an error that confirms the row exists.
 */
export async function mcpTokenConnected(tokenId: string): Promise<boolean> {
  const teamId = await requireActiveTeamId();
  await requireTeamWide("connected MCP clients");

  const reaching = await tokenIdsReaching(teamId);
  if (!reaching.has(tokenId)) return false;

  const rows = await getDb()
    .select({ mcpLastUsedAt: apiTokens.mcpLastUsedAt })
    .from(apiTokens)
    .where(eq(apiTokens.id, tokenId))
    .limit(1);
  return !!rows[0]?.mcpLastUsedAt;
}
