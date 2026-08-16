import "server-only";

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
import {
  createToken,
  tokenIdsReaching,
  type TokenScopeInput,
} from "./tokens";
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
  /**
   * The `api_tokens` id - Revoke goes through `revokeToken`, one lever, and it
   * removes THIS team's access rather than the whole connection (the client
   * keeps working in the other teams it was approved for, until the last one
   * lets go).
   */
  id: string;
  /**
   * How it got in. `web` is an OAuth connector (claude.ai, ChatGPT) that came
   * through the consent screen and carries a registered client's own name;
   * `token` is a `deplo_` bearer somebody pasted into a terminal or IDE agent,
   * and the only name it has is the one they gave the token.
   *
   * Two shapes, ONE list, because the question the screen answers is "what can
   * act in this team over MCP" and a split would answer it twice. Revoke is the
   * same call for both, which is the point of ADR-0022 §1.
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
 * Refuse to mint unless the person has JUST approved this client for real.
 *
 * Without this the mint answers to a `client_id` and a session and nothing
 * else — so a link to `/oauth/consent?client_id=<mine>` is enough to make
 * somebody with the capabilities click Authorize and mint a live API token
 * bound to a client they never heard of. It could not be used immediately (the
 * attacker still has no signed consent), but the credential would exist.
 *
 * The proof is a row rather than a signature: `POST /oauth2/consent` verifies
 * the provider's own HMAC over the authorization query before it writes
 * `oauth_consent`, so the row IS the verified approval, and re-deriving that
 * signature here would be re-implementing the library's crypto to learn
 * something the database already knows. The page therefore posts the consent
 * FIRST and mints second.
 *
 * Freshness matters as much as existence: a consent from a previous connection
 * would otherwise stay a standing permission to mint. Revoking the LAST team of
 * a connection deletes the row (`forgetOauthGrant`), and this window closes the
 * rest - including a partial revoke, which leaves the consent alone on purpose.
 */
async function assertFreshConsent(
  clientId: string,
  userId: string,
): Promise<void> {
  // The age is compared in JS, and that is the CORRECT half of a real trap.
  //
  // These are Better Auth's tables, so the columns are plain `timestamp`
  // WITHOUT a time zone — the one exception `AGENTS.md` allows to
  // `isoTimestamptz`. On a naive column the two writers do not agree: a value
  // the DRIVER writes (a JS `Date`, which is how the plugin writes this row)
  // reads back as the same instant, while a value SQL `now()` writes comes back
  // shifted by the server's offset. Measured on a UTC+2 box: driver-written is
  // off by 7ms, `now()`-written by exactly an hour. So comparing this row
  // against `now()` in SQL is what breaks, and comparing it against `Date.now()`
  // is what works. Anything seeding this table in a test has to write it the way
  // the application does, or it will disagree with production.
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
 * The teams the named projects, folders and apps belong to.
 *
 * A connection reaches every team its scope touches, not only the ones ticked
 * as wholes — so a project is a grant of its team, and has to pass the same
 * per-team gate. Refuses an id that resolves to nothing rather than silently
 * dropping it, because a scope that quietly loses a node is a scope nobody read.
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
 *
 * Asked per team and answered in that team: membership (which is also where the
 * two-factor policy refuses), the capability that governs AI access, and the
 * team's own switch. `createToken` clamps what the connection may DO to what the
 * approver holds, re-checked per team on every request — this is the separate
 * question of whether an agent belongs there at all.
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
 * The teams this person may connect an AI client to, right now.
 *
 * Exactly the question {@link assertMayConnect} asks at the mint, asked ahead of
 * time for every team they are in — so the consent screen can tick them all to
 * begin with. A screen that opens with nothing ticked never says which teams the
 * app is getting: the answer it silently meant ("the one you came from") was
 * readable only by someone who knew the rule. A team the person may NOT grant
 * stays unticked, because ticking it would turn Authorize into a refusal.
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
 * `teamIds` names the teams this connection may work in. The team it is created
 * FROM is always one of them — you cannot connect a client from here and leave
 * here out — and every team named gets the same gate, checked in that team and
 * not in this one.
 */
export interface AuthorizeMcpClientInput extends TokenScopeInput {
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

  // Which teams this connection may work in — and the gate runs once PER TEAM,
  // in that team.
  //
  // Naming a team is granting an AI client the run of it, so the question
  // `manage_mcp` answers ("may an agent drive this team at all") has to be asked
  // where the answer applies. Holding it here says nothing about there. The
  // team being connected FROM is always included: you cannot connect a client
  // from a team and leave that team out.
  //
  // Which team a given call then acts in is the call's own `team` argument — the
  // protocol is stateless, so it is declared per request and never remembered
  // (ADR-0021 §3). A team that was not granted is REFUSED there, never quietly
  // swapped for another: that silent swap is how an app was once created in a
  // team nobody had chosen.
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
 * The AI clients connected to the active team.
 *
 * Scoped like `listTokens`: a narrowed token has no business enumerating a team's
 * other credentials. Every connection that can ACT here is listed, whoever
 * approved it - the same row is also visible in Settings → API tokens, marked,
 * so one screen still answers "who can act in this team".
 *
 * TWO shapes, one list. An OAuth connector has an `oauth_client_id` from the
 * moment it is approved, so it is listed before it has ever called anything -
 * approving it IS the connection. A `deplo_` bearer has no such moment: it is
 * an ordinary token until somebody pastes it into Claude Code, and the only
 * evidence that happened is `mcp_last_used_at`. Listing every token that COULD
 * speak MCP instead would fill this screen with CI credentials and call them
 * connected agents, which is the opposite of what a company comes here to ask.
 */
export async function listMcpConnections(): Promise<McpConnectionDTO[]> {
  const teamId = await requireActiveTeamId();
  await requireTeamWide("connected MCP clients");

  // Every connection that can ACT here, not the ones minted here — the same rule
  // `listTokens` follows, and for its reason: a team that cannot see a
  // credential operating inside it cannot revoke it either. Filtering on the
  // home team looked identical while a connection reached exactly one team, and
  // would have hidden an agent from a team the moment one reached two.
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
 * Has this token spoken MCP yet?
 *
 * The connect wizard's last step waits on this rather than declaring success
 * when the snippet is copied: "you pasted a config" and "your agent is talking
 * to deplo" are different claims, and only the second one is worth showing
 * somebody. It is deliberately a boolean and not a timestamp — the caller is
 * asking one question, and an id from another team must answer it with `false`
 * rather than with an error that confirms the row exists.
 *
 * Gated exactly like `listMcpConnections`, because it is a one-row read of the
 * same list.
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
