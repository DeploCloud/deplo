import "server-only";

import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { getDb } from "../db/client";
import {
  apiTokenCapabilities,
  apiTokens,
  teams as teamsTable,
  users as usersTable,
} from "../db/schema/control-plane";
import { oauthClient } from "../db/schema/auth";
import {
  requireActiveTeamId,
  requireCapability,
  requireTeamWide,
} from "../membership";
import { assertUser, authHeaders } from "../auth";
import { requireAuth } from "../auth/better-auth";
import { ALL_CAPABILITIES, type Capability } from "../types";
import { createToken, type TokenScopeInput } from "./tokens";
import { getMcpSettings } from "./mcp-settings";
import { recordActivity } from "./activity";

/**
 * Connecting an AI client to a team, over OAuth.
 *
 * The whole design is in one sentence: **approving the consent screen mints an
 * ordinary `api_tokens` row**, and the OAuth access token the client goes on to
 * present is only a pointer at it (`lib/data/tokens.ts`). Nothing here decides
 * what an agent may do at request time — the token's Capabilities do, exactly as
 * for a token someone typed into a terminal. That is ADR-0021 §2's "there is no
 * second authorization path, and there must never be one", kept true by not
 * building one.
 *
 * So the gates below are the gates on MINTING a credential, not on using it:
 *
 *  - `manage_mcp` — whether this person may let an AI agent into the team at all
 *    (ADR-0021 §5). Calling `requireCapability` is also what runs `membershipFor`,
 *    which is where the team's two-factor policy refuses.
 *  - `teams.mcp_enabled` — the team's own switch, checked at the DOOR and not
 *    only at the request, so turning it off does not leave connections that
 *    resume the moment it flips back.
 *  - `manage_tokens` + `withinActor`, inside `createToken` — nobody grants a
 *    capability they do not hold themselves.
 *
 * `instanceAdmin` is not a parameter and cannot be reached from here: the token
 * is always scoped to the chosen team, and a scoped token is refused instance
 * administration outright.
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
  /** The `api_tokens` id — Revoke goes through `revokeToken`, one lever. */
  id: string;
  clientName: string;
  clientUri: string | null;
  clientIcon: string | null;
  redirectOrigin: string | null;
  username: string | null;
  teamId: string;
  teamName: string;
  capabilities: Capability[];
  lastUsedAt: string | null;
  createdAt: string;
}

/** Names longer than this are clamped — `createToken` refuses over 40. */
const MAX_CLIENT_NAME = 40;

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
 *
 * Read straight from the row rather than through `auth.api`: this is public
 * metadata a client published about itself at registration, it is not team state,
 * and the consent page is an RSC that needs it before anything is gated. Returns
 * null for an unknown or disabled client so the page can refuse plainly.
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

export interface AuthorizeMcpClientInput extends TokenScopeInput {
  clientId: string;
  capabilities?: Capability[];
  /** The OAuth scopes to grant back, verbatim from the authorize request. */
  scope?: string;
  /** The signed authorization query the plugin put on the consent page's URL. */
  oauthQuery?: string;
}

/**
 * Approve a consent: mint the credential, then tell the plugin to hand the client
 * its authorization code.
 *
 * The `raw` secret `createToken` returns is DROPPED on the floor here. It is a
 * live bearer, and the client is going to be given an OAuth access token instead;
 * letting it reach the response, the redirect URL or the Activity trail would
 * leave a working credential behind after the connection is revoked.
 *
 * Order matters. The token is minted BEFORE the consent is recorded, because a
 * consent with no credential behind it would hand the client a code that resolves
 * to nothing. The reverse leftover — a token whose consent call then failed — is
 * visible as an unused connection in both settings pages and is one click to
 * revoke, and re-approving overwrites it through the `(client_id, user_id)`
 * unique index.
 */
export async function authorizeMcpClient(
  input: AuthorizeMcpClientInput,
): Promise<{ redirectUrl: string }> {
  await mintMcpConnection(input);
  const result = await requireAuth().api.oauth2Consent({
    body: {
      accept: true,
      ...(input.scope ? { scope: input.scope } : {}),
      ...(input.oauthQuery ? { oauth_query: input.oauthQuery } : {}),
    },
    headers: await authHeaders(),
  });
  return { redirectUrl: result.url };
}

/**
 * Every gate, and the mint. Split from the handshake above because THIS is the
 * security boundary: the OAuth call after it is glue that needs a browser's
 * cookies, and a boundary that can only be exercised through a browser is a
 * boundary nothing tests.
 */
export async function mintMcpConnection(
  input: AuthorizeMcpClientInput,
): Promise<{ tokenId: string }> {
  // Runs `membershipFor`, so an unmet two-factor policy refuses here.
  const { teamId, userId } = await requireCapability("manage_mcp");
  // A narrowed token must not be able to mint a whole-team connection.
  await requireTeamWide("connecting an AI client");

  if (!(await getMcpSettings()).enabled)
    throw new Error(
      "This team has turned off MCP access. An admin can switch it back on under Settings → MCP Server.",
    );

  const client = await getOAuthClientForConsent(input.clientId);
  if (!client) throw new Error("That app is not registered with deplo");

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

  const { token } = await createToken({
    name: client.name.slice(0, MAX_CLIENT_NAME),
    capabilities: input.capabilities,
    // Breadth, not depth: naming the team scopes the connection to it without
    // stripping the team-wide capabilities the user actually ticked. Naming a
    // project or app underneath IS depth, and is what the scope picker means.
    teamIds: input.teamIds?.length ? input.teamIds : [teamId],
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

/** Turn down a consent without minting anything. */
export async function denyMcpClient(input: {
  oauthQuery?: string;
}): Promise<{ redirectUrl: string }> {
  await assertUser();
  const result = await requireAuth().api.oauth2Consent({
    body: {
      accept: false,
      ...(input.oauthQuery ? { oauth_query: input.oauthQuery } : {}),
    },
    headers: await authHeaders(),
  });
  return { redirectUrl: result.url };
}

/**
 * The AI clients connected to the active team.
 *
 * Scoped like `listTokens`: a narrowed token has no business enumerating a team's
 * other credentials. Only connections whose token is MANAGED from this team are
 * listed — the same row is also visible in Settings → API tokens, marked, so one
 * screen still answers "who can act in this team".
 */
export async function listMcpConnections(): Promise<McpConnectionDTO[]> {
  const teamId = await requireActiveTeamId();
  await requireTeamWide("connected MCP clients");

  const rows = await getDb()
    .select({
      id: apiTokens.id,
      teamId: apiTokens.teamId,
      teamName: teamsTable.name,
      username: usersTable.username,
      lastUsedAt: apiTokens.lastUsedAt,
      createdAt: apiTokens.createdAt,
      clientName: oauthClient.name,
      clientUri: oauthClient.uri,
      clientIcon: oauthClient.icon,
      redirectUris: oauthClient.redirectUris,
    })
    .from(apiTokens)
    .innerJoin(oauthClient, eq(oauthClient.clientId, apiTokens.oauthClientId))
    .leftJoin(usersTable, eq(usersTable.id, apiTokens.userId))
    .leftJoin(teamsTable, eq(teamsTable.id, apiTokens.teamId))
    .where(
      and(eq(apiTokens.teamId, teamId), isNotNull(apiTokens.oauthClientId)),
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

  return rows.map((r) => ({
    id: r.id,
    clientName: r.clientName ?? "Unknown app",
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
    createdAt: r.createdAt,
  }));
}
