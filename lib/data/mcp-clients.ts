import "server-only";

import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { getDb } from "../db/client";
import {
  apiTokenCapabilities,
  apiTokens,
  apps as appsTable,
  folders as foldersTable,
  projects as projectsTable,
  teams as teamsTable,
  users as usersTable,
} from "../db/schema/control-plane";
import { oauthClient } from "../db/schema/auth";
import {
  requireActiveTeamId,
  requireCapability,
  requireTeamWide,
} from "../membership";
import { assertUser } from "../auth";
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

/**
 * Refuse a scope that narrows to something outside the team being connected.
 *
 * `createToken` already refuses a node in a team the approver does not belong
 * to; this is the stricter rule a connection needs, because a project belonging
 * to ANOTHER of their teams would make the connection reach two teams and land
 * it back in the "which team is this request in" ambiguity above.
 */
async function assertNodesInTeam(
  input: TokenScopeInput,
  teamId: string,
): Promise<void> {
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
  // Deduped, like `resolveScopeInput` does: the same id twice is a UI slip, not
  // a reason to refuse a legitimate scope.
  const named = new Set([
    ...(input.projectIds ?? []),
    ...(input.folderIds ?? []),
    ...(input.appIds ?? []),
  ]).size;
  const found = [...projectRows, ...folderRows, ...appRows];
  if (found.length !== named || found.some((r) => r.teamId !== teamId))
    throw new Error(
      "A connection can only be narrowed to projects, folders or apps inside the team you are connecting.",
    );
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

/**
 * `teamIds` is deliberately absent. A connection serves exactly one team and the
 * team comes from the session, so an argument for it could only ever be ignored
 * or believed — and believing it is the bug this omission closes.
 */
export interface AuthorizeMcpClientInput
  extends Omit<TokenScopeInput, "teamIds"> {
  clientId: string;
  capabilities?: Capability[];
  /**
   * The team the consent screen SHOWED, for the server to disagree with.
   *
   * Not the client choosing the team — the server still takes it from the
   * session. This is the screen saying what it displayed, so a team that
   * changed underneath (another tab, a half-finished switch) is refused instead
   * of quietly connecting the client somewhere the person never read.
   */
  expectedTeamId?: string;
}

/**
 * Every gate, and the mint. This is deplo's whole half of a consent.
 *
 * The `raw` secret `createToken` returns is DROPPED on the floor. It is a live
 * bearer, and the client is going to be handed an OAuth access token instead;
 * letting it reach a response, a redirect URL or the Activity trail would leave
 * a working credential behind after the connection is revoked.
 *
 * The credential is minted BEFORE the browser posts the consent, because a
 * consent with nothing behind it hands the client a code that resolves to
 * nothing. The opposite leftover — a token whose consent then failed — shows up
 * as an unused connection in both settings pages, is one click to revoke, and is
 * overwritten by re-approving through the `(client_id, user_id)` unique index.
 *
 * **The handshake that follows is the BROWSER's, not ours, and it cannot be
 * moved here.** `POST /api/auth/oauth2/consent` funnels into the provider's
 * `authorizeEndpoint`, which opens with `if (!ctx.request) throw
 * UNAUTHORIZED("request not found")` — an in-process `auth.api.*({body,
 * headers})` call has no `ctx.request` by construction, so calling it from a
 * resolver fails every time, and it fails with an APIError whose `message` is
 * EMPTY (the reason lives in `body.error_description`), which surfaces as an
 * error notification with nothing written in it. Mint here, let the page post
 * the consent, and both halves are exercised by the path production uses.
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

  // ONE TEAM, decided here and not by the caller.
  //
  // A connection carries no `X-Deplo-Team` — the protocol is stateless and one
  // endpoint serves one team (ADR-0021 §3), so there is nothing for the header,
  // or a "switch team" tool, to switch. Which means a scope naming several teams
  // has no way to say which one a request acts in: `authenticateToken` falls
  // back to the first reachable team, i.e. the OLDEST one the approver belongs
  // to. An agent then quietly works in a team nobody chose — it created an app
  // in the wrong one before this was fixed.
  //
  // So the team comes from the session, the client's `teamIds` are ignored, and
  // narrowing is only ever allowed INSIDE that team.
  const narrowing = [
    ...(input.projectIds ?? []),
    ...(input.folderIds ?? []),
    ...(input.appIds ?? []),
  ];
  if (narrowing.length > 0) await assertNodesInTeam(input, teamId);

  const { token } = await createToken({
    name: client.name.slice(0, MAX_CLIENT_NAME),
    capabilities: input.capabilities,
    // Breadth or depth, never both: naming the whole team AND a project inside
    // it reads as the whole team, which would silently undo the narrowing.
    teamIds: narrowing.length > 0 ? [] : [teamId],
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
