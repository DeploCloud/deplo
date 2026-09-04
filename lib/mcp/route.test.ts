process.env.DEPLO_PUBLIC_URL = "https://deplo.test";

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import {
  PROTOCOL_VERSION_META_KEY,
  CLIENT_CAPABILITIES_META_KEY,
} from "@modelcontextprotocol/server";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import {
  seedIdentity,
  TEAM_A,
  TEAM_B,
  USER_1,
} from "../data/identity-test-helpers";
import { runWithIdentity } from "../auth/request-context";
import { createToken } from "../data/tokens";
import { resetAuth } from "../auth/better-auth";
import {
  authorize,
  consent,
  exchange,
  fullFlow,
  pkcePair,
  refresh,
  registerClient,
  signIn,
} from "../auth/oauth-test-helpers";
import { mintMcpConnection } from "../data/mcp-clients";
import { revokeToken } from "../data/tokens";
import { buildContext } from "../graphql/context";
import { POST, GET, OPTIONS } from "@/app/api/mcp/route";
import { GET as PROTECTED_RESOURCE } from "@/app/.well-known/oauth-protected-resource/api/mcp/route";
import type { Capability } from "../types";

/**
 * The MCP endpoint as a resource server. The first section is the regression net:
 * it passes on the pre-OAuth code and is what says "we did not break Deplo".
 */

let db: TestDb;
let pg: PGlite;

const EMAIL = `${USER_1}@example.io`;
const PASSWORD = "password1";
const RESOURCE = "https://deplo.test/api/mcp";

const TRUNCATE = `truncate table
  oauth_access_token, oauth_refresh_token, oauth_consent, oauth_client,
  verification, session, account, api_tokens, membership_capabilities,
  memberships, users, teams, rate_limits
  restart identity cascade;`;

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
  resetAuth();
});

after(async () => {
  __resetTestDb();
  resetAuth();
  await pg.close();
});

beforeEach(async () => {
  await pg.exec(TRUNCATE);
  await seedIdentity(db);
  // USER_1 owns BOTH teams. That is the case that actually breaks: without a
  // second membership, "the header cannot move the connection" would pass for
  // the wrong reason - the team simply being out of reach.
  await pg.query(
    `insert into memberships (id, user_id, team_id, role, created_at)
     values ('mem_user_1_b', $1, $2, 'owner', '2026-01-01T00:00:00.000Z')`,
    [USER_1, TEAM_B],
  );
  await pg.query(
    `insert into membership_capabilities (membership_id, capability)
     select 'mem_user_1_b', capability from membership_capabilities
     where membership_id = 'mem_user_1'`,
  );
});

/** One JSON-RPC call at the route, exactly as a client would make it. */
async function mcp(
  bearer: string | null,
  opts: {
    team?: string;
    tool?: string;
    cookie?: string;
    toolArgs?: Record<string, unknown>;
  } = {},
): Promise<{
  status: number;
  headers: Headers;
  body: Record<string, unknown>;
}> {
  const tool = opts.tool ?? "whoami";
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    // Both are REQUIRED on a 2026-07-28 POST (SEP-2243); the SDK refuses a
    // mismatch rather than guessing.
    "mcp-method": "tools/call",
    "mcp-name": tool,
  };
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  if (opts.team) headers["x-deplo-team"] = opts.team;
  if (opts.cookie) headers.cookie = opts.cookie;
  const res = await POST(
    new Request(RESOURCE, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: tool,
          arguments: opts.toolArgs ?? {},
          _meta: {
            [PROTOCOL_VERSION_META_KEY]: "2026-07-28",
            [CLIENT_CAPABILITIES_META_KEY]: {},
          },
        },
      }),
    }),
  );
  const text = await res.text();
  // The handler answers either as one JSON body or as a single SSE frame.
  const payload = text.startsWith("data:")
    ? text.slice(text.indexOf("data:") + 5).split("\n")[0]
    : text;
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(payload) as Record<string, unknown>;
  } catch {
    body = { raw: text };
  }
  return { status: res.status, headers: res.headers, body };
}

/** The tool's own JSON, out of the JSON-RPC envelope the SDK wraps it in. */
function toolJson(body: Record<string, unknown>): {
  viewerTeam?: { id?: string };
  [k: string]: unknown;
} {
  const text = (
    body as { result?: { content?: { type: string; text?: string }[] } }
  ).result?.content?.find((c) => c.type === "text")?.text;
  assert.ok(text, `no text content in ${JSON.stringify(body)}`);
  return JSON.parse(text!) as { viewerTeam?: { id?: string } };
}

/** Mint an ordinary API token as USER_1 in TEAM_A. */
function mintToken(capabilities: Capability[]) {
  return runWithIdentity({ userId: USER_1, teamId: TEAM_A }, () =>
    createToken({ name: "agent", capabilities, teamIds: [TEAM_A] }),
  );
}

/**
 * A complete OAuth connection: the real flow issues the credentials, then the
 * `api_tokens` row is minted and linked exactly as `mintMcpConnection` does.
 */
async function connect(
  capabilities: Capability[] = ["view"],
  teamIds: string[] = [TEAM_A],
) {
  const flow = await fullFlow({
    email: EMAIL,
    password: PASSWORD,
    resource: RESOURCE,
  });
  const { token } = await runWithIdentity(
    { userId: USER_1, teamId: TEAM_A },
    () => createToken({ name: "Test AI client", capabilities, teamIds }),
  );
  await pg.query(`update api_tokens set oauth_client_id = $1 where id = $2`, [
    flow.clientId,
    token.id,
  ]);
  return { ...flow, tokenId: token.id };
}

/* ------------------------------------------------------------------ */
/* 0. The whole loop, in production's order                            */
/* ------------------------------------------------------------------ */

test("register → sign in → authorize → mint → consent → exchange → a tool answers", async () => {
  // The test that was missing, and the reason a broken flow shipped twice: every
  // other test here exercises ONE seam.
  const reg = await registerClient();
  const clientId = String(reg.body.client_id);
  const cookie = await signIn(EMAIL, PASSWORD);

  const { verifier, challenge } = pkcePair();
  const authorized = await authorize(cookie, {
    client_id: clientId,
    redirect_uri: "https://client.test/callback",
    response_type: "code",
    scope: "openid offline_access",
    state: "st",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: RESOURCE,
  });
  assert.match(
    String(authorized.location),
    /^\/oauth\/consent\?/,
    "authorize must land on Deplo's own consent page",
  );

  // What the consent page's browser fetch does FIRST - it verifies the
  // provider's signature and records the approval.
  const approved = await consent(cookie, {
    accept: true,
    oauth_query: authorized.oauthQuery ?? "",
  });
  assert.equal(approved.status, 200, `consent refused (${approved.status})`);

  // And only then what the GraphQL resolver does, behind every gate, which now
  // requires that recorded approval to exist.
  await runWithIdentity({ userId: USER_1, teamId: TEAM_A }, () =>
    mintMcpConnection({ clientId, capabilities: ["view"] }),
  );

  const code = new URL(approved.url!).searchParams.get("code");
  assert.ok(code, `no code in ${approved.url}`);

  const token = await exchange({
    grant_type: "authorization_code",
    code: code!,
    code_verifier: verifier,
    client_id: clientId,
    redirect_uri: "https://client.test/callback",
    resource: RESOURCE,
  });
  assert.ok(token.body.access_token, JSON.stringify(token.body));

  const res = await mcp(token.body.access_token);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.ok(JSON.stringify(res.body).includes(USER_1));
  assert.ok(JSON.stringify(res.body).includes(TEAM_A));
});

test("a refreshed access token keeps working, and the spent refresh token dies", async () => {
  // An access token lives an hour.
  const conn = await connect(["view"]);
  assert.equal((await mcp(conn.accessToken)).status, 200);
  assert.ok(conn.refreshToken, "the flow should have issued a refresh token");

  const again = await refresh(conn.refreshToken!, conn.clientId, RESOURCE);
  assert.ok(again.body.access_token, JSON.stringify(again.body));
  assert.notEqual(again.body.access_token, conn.accessToken);

  const res = await mcp(again.body.access_token);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(toolJson(res.body).viewerTeam?.id, TEAM_A);
  // Still the same connection, not a second one.
  const rows = (
    await pg.query(`select id from api_tokens where oauth_client_id = $1`, [
      conn.clientId,
    ])
  ).rows as { id: string }[];
  assert.equal(rows.length, 1);

  // The REFRESH token rotates and the spent one is dead - that is the property that
  // matters, and the one a stolen refresh token would otherwise defeat.
  assert.notEqual(again.body.refresh_token, conn.refreshToken);
  const replayed = await refresh(conn.refreshToken!, conn.clientId, RESOURCE);
  assert.ok(!replayed.body.access_token, "a spent refresh token was reusable");
});

test("revoking the connection also kills its refresh token", async () => {
  // Otherwise revocation is a one-hour inconvenience: the client just refreshes.
  const conn = await connect(["view"]);
  await runWithIdentity({ userId: USER_1, teamId: TEAM_A }, () =>
    revokeToken(conn.tokenId),
  );
  const again = await refresh(conn.refreshToken!, conn.clientId, RESOURCE);
  assert.ok(!again.body.access_token, "a revoked connection refreshed itself");
});

test("an access token with no user behind it authenticates nothing", async () => {
  // The shape a machine-to-machine grant would have. It can only ever resolve
  // through a connection, and a connection belongs to a person, so the join
  // finds nothing rather than falling back to anything.
  const conn = await connect(["view"]);
  await pg.query(
    `insert into oauth_access_token
       (id, token, client_id, user_id, expires_at, created_at, scopes)
     values ('oat_m2m', $1, $2, null, now() + interval '1 hour', now(), ARRAY['openid'])`,
    ["deadbeef".repeat(8), conn.clientId],
  );
  const res = await mcp(`dplo_at_${"x".repeat(20)}`);
  assert.equal(res.status, 401);
});

test("the same connection authenticates on the GraphQL API, with the same clamp", async () => {
  // Deliberate: an OAuth grant IS an API token, so it reaches /api/graphql too.
  // That is the widest surface it touches, and nothing tested it - a divergence
  // here would mean two principals after all.
  const conn = await connect(["view"]);
  const ctx = await buildContext(
    new Request("https://deplo.test/api/graphql", {
      method: "POST",
      headers: { authorization: `Bearer ${conn.accessToken}` },
    }),
  );
  assert.equal(ctx.via, "token");
  assert.equal(ctx.viewer?.id, USER_1);
  assert.equal(ctx.teamId, TEAM_A);
  // The clamp travels with it: `view` only, not the owner's whole set.
  assert.deepEqual(ctx.capabilities, ["view"]);
});

test("an unauthenticated authorize sends the signed query to the login page", async () => {
  // The login page resumes the flow by re-running authorize, and it recognises that
  // state by `client_id` + `sig` being on ITS url.
  const reg = await registerClient();
  const res = await authorize("", {
    client_id: String(reg.body.client_id),
    redirect_uri: "https://client.test/callback",
    response_type: "code",
    scope: "openid",
    state: "st",
    code_challenge: pkcePair().challenge,
    code_challenge_method: "S256",
  });
  assert.match(String(res.location), /^\/login\?/, String(res.location));
  const sent = new URLSearchParams(res.oauthQuery ?? "");
  assert.ok(
    sent.get("client_id"),
    "no client_id for the login page to resume on",
  );
  assert.ok(sent.get("sig"), "no signature for the login page to resume on");
});

/* ------------------------------------------------------------------ */
/* 1. Baseline - the pre-OAuth path is unchanged                       */
/* ------------------------------------------------------------------ */

test("a deplo_ token still reaches its tools and resolves as its creator", async () => {
  const { raw } = await mintToken(["view"]);
  const res = await mcp(raw);
  assert.equal(res.status, 200);
  assert.ok(
    JSON.stringify(res.body).includes(USER_1),
    JSON.stringify(res.body),
  );
});

test("a deplo_ token without the capability cannot reach the tool", async () => {
  // The tool list is filtered per token, so a capability it does not hold makes the
  // tool unreachable rather than merely refused.
  const { raw } = await mintToken(["view"]);
  const res = await mcp(raw, { tool: "delete_app" });
  assert.ok(res.body.error, JSON.stringify(res.body));
  assert.ok(!res.body.result, "delete_app ran for a view-only token");
});

test("the team kill switch refuses with the sentence that names the setting", async () => {
  const { raw } = await mintToken(["view"]);
  await pg.query(`update teams set mcp_enabled = false where id = $1`, [
    TEAM_A,
  ]);
  const res = await mcp(raw);
  assert.equal(res.status, 403);
  assert.match(String(res.body.error), /Settings → MCP Server/);
});

/* ------------------------------------------------------------------ */
/* 1b. The MCP usage stamp                                             */
/* ------------------------------------------------------------------ */

/**
 * `mcp_last_used_at` is what makes a `deplo_` token visible on Settings → MCP
 * Server at all, and what the connect wizard's last step waits on.
 */

/** The write is fire-and-forget, so poll rather than assume it landed. */
async function mcpStampOf(tokenId: string, tries = 40) {
  for (let i = 0; i < tries; i++) {
    const { rows } = await pg.query<{ mcp_last_used_at: string | null }>(
      `select mcp_last_used_at from api_tokens where id = $1`,
      [tokenId],
    );
    if (rows[0]?.mcp_last_used_at) return rows[0].mcp_last_used_at;
    await new Promise((r) => setTimeout(r, 25));
  }
  return null;
}

test("a served MCP call stamps the token as having spoken MCP", async () => {
  const { raw, token } = await mintToken(["view"]);
  const before = await pg.query<{ mcp_last_used_at: string | null }>(
    `select mcp_last_used_at from api_tokens where id = $1`,
    [token.id],
  );
  assert.equal(before.rows[0].mcp_last_used_at, null, "starts unstamped");

  assert.equal((await mcp(raw)).status, 200);
  assert.ok(
    await mcpStampOf(token.id),
    "a served MCP call left no mcp_last_used_at",
  );
});

test("a call the kill switch refuses does not stamp it", async () => {
  // A token the team just turned away is not a connected client, and listing it
  // as one would put an agent on that screen the moment MCP was switched off.
  const { raw, token } = await mintToken(["view"]);
  await pg.query(`update teams set mcp_enabled = false where id = $1`, [
    TEAM_A,
  ]);
  assert.equal((await mcp(raw)).status, 403);
  // Long enough that a stamp taken before the gate would have landed by now.
  await new Promise((r) => setTimeout(r, 150));
  const { rows } = await pg.query<{ mcp_last_used_at: string | null }>(
    `select mcp_last_used_at from api_tokens where id = $1`,
    [token.id],
  );
  assert.equal(rows[0].mcp_last_used_at, null);
});

test("an unmet two-factor policy answers 401 with a sentence, not a 500", async () => {
  const { raw } = await mintToken(["view"]);
  await pg.query(`update teams set require_two_factor = true where id = $1`, [
    TEAM_A,
  ]);
  const res = await mcp(raw);
  assert.equal(res.status, 401);
  assert.match(String(res.body.error), /two-factor|2fa/i);
});

test("GET explains itself and runs nothing", async () => {
  const res = await GET();
  assert.equal(res.status, 405);
  assert.equal(res.headers.get("allow"), "POST");
});

test("OPTIONS preflights without a credential", async () => {
  const res = OPTIONS();
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  // Without this a browser client cannot read the challenge and never discovers
  // the authorization server at all.
  assert.match(
    String(res.headers.get("access-control-expose-headers")),
    /www-authenticate/i,
  );
});

/* ------------------------------------------------------------------ */
/* 2. The challenge                                                    */
/* ------------------------------------------------------------------ */

test("the 401 carries a resource_metadata URL that actually resolves", async () => {
  const res = await mcp(null);
  assert.equal(res.status, 401);
  const challenge = String(res.headers.get("www-authenticate"));
  const match = /resource_metadata="([^"]+)"/.exec(challenge);
  assert.ok(match, challenge);
  const doc = await PROTECTED_RESOURCE();
  assert.equal(doc.status, 200);
  const body = (await doc.json()) as { resource: string };
  assert.equal(body.resource, RESOURCE);
  assert.equal(
    match![1],
    `https://deplo.test/.well-known/oauth-protected-resource/api/mcp`,
  );
});

test("the challenge names no team, user or token", async () => {
  const { raw } = await mintToken(["view"]);
  const res = await mcp(`${raw}x`);
  const dump = `${res.headers.get("www-authenticate")} ${JSON.stringify(res.body)}`;
  for (const secret of [USER_1, TEAM_A, raw])
    assert.ok(!dump.includes(secret), `the 401 is an oracle: leaked ${secret}`);
});

/* ------------------------------------------------------------------ */
/* 3. An OAuth token is the same principal                             */
/* ------------------------------------------------------------------ */

test("an OAuth access token reaches the same tools as the equivalent deplo_ token", async () => {
  const conn = await connect(["view"]);
  const viaOauth = await mcp(conn.accessToken);
  assert.equal(viaOauth.status, 200, JSON.stringify(viaOauth.body));
  assert.ok(JSON.stringify(viaOauth.body).includes(USER_1));
  assert.ok(JSON.stringify(viaOauth.body).includes(TEAM_A));
});

test("an OAuth token holding only view cannot delete an app", async () => {
  const conn = await connect(["view"]);
  const res = await mcp(conn.accessToken, { tool: "delete_app" });
  assert.ok(res.body.error, JSON.stringify(res.body));
  assert.ok(!res.body.result, "delete_app ran for a view-only connection");
});

/* ------------------------------------------------------------------ */
/* 4. Credential confusion                                             */
/* ------------------------------------------------------------------ */

test("a refresh token presented as a bearer authenticates nothing", async () => {
  // The plugin stores both on rows a sloppy `or` would match. Accepting one here
  // is total compromise: a refresh token is long-lived and survives revocation
  // of the access token.
  const conn = await connect(["view"]);
  assert.ok(conn.refreshToken, "the flow should have issued a refresh token");
  const res = await mcp(conn.refreshToken!);
  assert.equal(res.status, 401);
});

test("an authorization code presented as a bearer authenticates nothing", async () => {
  const conn = await connect(["view"]);
  const res = await mcp(conn.code);
  assert.equal(res.status, 401);
});

test("an id_token presented as a bearer authenticates nothing", async () => {
  // id_tokens are HS256-signed with the CLIENT's own secret, so accepting one
  // would let any registered client forge any identity it liked.
  const flow = await fullFlow({
    email: EMAIL,
    password: PASSWORD,
    scope: "openid profile email",
  });
  if (!flow.idToken) return;
  const res = await mcp(flow.idToken);
  assert.equal(res.status, 401);
});

test("a session cookie alone reaches no tool", async () => {
  // If /api/mcp ever became cookie-authenticable, every signed-in browser would
  // be one cross-site POST away from driving the whole team.
  const conn = await connect(["view"]);
  const res = await mcp(null, { cookie: `__Secure-deplo.session_token=x` });
  assert.equal(res.status, 401);
  assert.ok(conn.accessToken);
});

test("an unknown token and a revoked token answer identically", async () => {
  const conn = await connect(["view"]);
  await pg.query(`delete from api_tokens where id = $1`, [conn.tokenId]);
  const revoked = await mcp(conn.accessToken);
  const unknown = await mcp("dplo_at_never-existed");
  assert.equal(revoked.status, unknown.status);
  assert.deepEqual(revoked.body, unknown.body);
});

test("an OAuth token for one client does not resolve another client's grant", async () => {
  const first = await connect(["view"]);
  // A second registered client, with no connection of its own.
  const second = await fullFlow({
    email: EMAIL,
    password: PASSWORD,
    resource: RESOURCE,
  });
  const res = await mcp(second.accessToken);
  assert.equal(res.status, 401, "an unconnected client borrowed a grant");
  const ok = await mcp(first.accessToken);
  assert.equal(ok.status, 200);
});

/* ------------------------------------------------------------------ */
/* 5. Revocation, with no TTL window                                   */
/* ------------------------------------------------------------------ */

test("deleting the minted token stops the NEXT request", async () => {
  const conn = await connect(["view"]);
  assert.equal((await mcp(conn.accessToken)).status, 200);
  await pg.query(`delete from api_tokens where id = $1`, [conn.tokenId]);
  assert.equal((await mcp(conn.accessToken)).status, 401);
});

test("disabling the client stops the next request", async () => {
  // The plugin's own token lookup never reads this column; Deplo's join does.
  const conn = await connect(["view"]);
  assert.equal((await mcp(conn.accessToken)).status, 200);
  await pg.query(
    `update oauth_client set disabled = true where client_id = $1`,
    [conn.clientId],
  );
  assert.equal((await mcp(conn.accessToken)).status, 401);
});

test("an expired access token stops the next request", async () => {
  const conn = await connect(["view"]);
  await pg.query(
    `update oauth_access_token set expires_at = now() - interval '1 hour'`,
  );
  assert.equal((await mcp(conn.accessToken)).status, 401);
});

test("the team kill switch stops an OAuth connection too", async () => {
  const conn = await connect(["view"]);
  await pg.query(`update teams set mcp_enabled = false where id = $1`, [
    TEAM_A,
  ]);
  assert.equal((await mcp(conn.accessToken)).status, 403);
});

test("losing the membership stops an OAuth connection", async () => {
  // ADR-0015's fail-closed promise, restated for the new credential shape: a
  // token acts only in teams its minter is STILL in.
  const conn = await connect(["view"]);
  await pg.query(`delete from memberships where user_id = $1`, [USER_1]);
  assert.equal((await mcp(conn.accessToken)).status, 401);
});

test("turning on the team two-factor policy stops an issued connection", async () => {
  const conn = await connect(["view"]);
  assert.equal((await mcp(conn.accessToken)).status, 200);
  await pg.query(`update teams set require_two_factor = true where id = $1`, [
    TEAM_A,
  ]);
  const res = await mcp(conn.accessToken);
  assert.equal(res.status, 401);
  assert.match(String(res.body.error), /two-factor|2fa/i);
});

/* ------------------------------------------------------------------ */
/* 6. Cross-team                                                       */
/* ------------------------------------------------------------------ */

test("X-Deplo-Team cannot move an OAuth connection to a team it was not granted", async () => {
  // The case that actually breaks: the approver owns BOTH teams, so nothing but
  // the connection's own scope stands between the client and team B.
  const conn = await connect(["view"]);
  const res = await mcp(conn.accessToken, { team: "beta" });
  assert.equal(res.status, 200);
  const text = JSON.stringify(res.body);
  assert.ok(text.includes(TEAM_A), text);
  assert.ok(
    !text.includes(TEAM_B),
    "the header moved the connection to team B",
  );
});

test("list_teams names every team, and says why one is off limits", async () => {
  const conn = await connect(["view"], [TEAM_A, TEAM_B]);
  await pg.query(`update teams set mcp_enabled = false where id = $1`, [
    TEAM_B,
  ]);
  const res = await mcp(conn.accessToken, { tool: "list_teams" });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const teams = toolJson(res.body).mcpTeams as {
    id: string;
    mcpEnabled: boolean;
    canConnect: boolean;
  }[];
  assert.deepEqual(
    teams.map((t) => [t.id, t.mcpEnabled, t.canConnect]).sort(),
    [
      [TEAM_A, true, true],
      [TEAM_B, false, true],
    ],
  );
});

test("the team argument is advertised on every tool, even with one team in reach", async () => {
  // The whole reason an agent once said it "had no way to change team".
  const conn = await connect(["view"], [TEAM_A]);
  const res = await POST(
    new Request(RESOURCE, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-method": "tools/list",
        authorization: `Bearer ${conn.accessToken}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {
          _meta: {
            [PROTOCOL_VERSION_META_KEY]: "2026-07-28",
            [CLIENT_CAPABILITIES_META_KEY]: {},
          },
        },
      }),
    }),
  );
  const text = await res.text();
  const payload = text.startsWith("data:")
    ? text.slice(text.indexOf("data:") + 5).split("\n")[0]
    : text;
  const body = JSON.parse(payload) as {
    result: { tools: { name: string; inputSchema: { properties?: object } }[] };
  };
  const whoami = body.result.tools.find((t) => t.name === "whoami");
  assert.ok(whoami, "whoami missing");
  assert.ok(
    "team" in (whoami.inputSchema.properties ?? {}),
    "the team argument is not advertised",
  );
  assert.ok(
    body.result.tools.some((t) => t.name === "list_teams"),
    "list_teams missing",
  );
});

test("a team where the owner may not connect agents refuses, and names the permission", async () => {
  const conn = await connect(["view"], [TEAM_A, TEAM_B]);
  await pg.query(
    `delete from membership_capabilities where membership_id = 'mem_user_1_b' and capability = 'manage_mcp'`,
  );
  const there = await mcp(conn.accessToken, { toolArgs: { team: "beta" } });
  const body = JSON.stringify(there.body);
  assert.match(body, /Connect AI agents/, body);
  assert.ok(
    !body.includes(`"id":"${TEAM_B}"`),
    "it answered about the team anyway",
  );
});

test("losing manage_mcp in the default team lands the connection in a usable one", async () => {
  const conn = await connect(["view"], [TEAM_A, TEAM_B]);
  await pg.query(
    `delete from membership_capabilities where membership_id = 'mem_user_1' and capability = 'manage_mcp'`,
  );
  // No team asked for: the door moves to the one that still allows it.
  const res = await mcp(conn.accessToken);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(toolJson(res.body).viewerTeam?.id, TEAM_B);
  // Asked for explicitly, the refusal names the permission and the way out.
  const asked = await mcp(conn.accessToken, { team: "alpha" });
  assert.equal(asked.status, 403);
  assert.match(String(asked.body.error), /Connect AI agents/);
  assert.match(String(asked.body.error), /can act in: beta/);
});

test("losing manage_mcp everywhere refuses the door outright", async () => {
  const { raw } = await mintToken(["view"]);
  await pg.query(
    `delete from membership_capabilities where capability = 'manage_mcp'`,
  );
  const res = await mcp(raw);
  assert.equal(res.status, 403);
  assert.match(String(res.body.error), /Connect AI agents/);
  // The same credential still drives the GraphQL API: `manage_mcp` gates
  // agents, not tokens.
  const ctx = await buildContext(
    new Request("https://deplo.test/api/graphql", {
      headers: { authorization: `Bearer ${raw}` },
    }),
  );
  assert.equal(ctx.teamId, TEAM_A);
});

test("losing manage_tokens narrows the connection to the teams that still allow it", async () => {
  const conn = await connect(["view"], [TEAM_A, TEAM_B]);
  await pg.query(
    `delete from membership_capabilities where membership_id = 'mem_user_1' and capability = 'manage_tokens'`,
  );
  // The header keeps its documented lenient fallback (ADR-0022 §3)...
  const viaHeader = await mcp(conn.accessToken, { team: "alpha" });
  assert.equal(viaHeader.status, 200, JSON.stringify(viaHeader.body));
  assert.equal(toolJson(viaHeader.body).viewerTeam?.id, TEAM_B);
  // ...and the tool argument is strict: an unreachable team is a refusal.
  const viaArg = await mcp(conn.accessToken, { toolArgs: { team: "alpha" } });
  assert.match(JSON.stringify(viaArg.body), /no access to the team/i);
  // list_teams no longer names it at all.
  const teams = toolJson(
    (await mcp(conn.accessToken, { tool: "list_teams" })).body,
  ).mcpTeams as { id: string }[];
  assert.deepEqual(
    teams.map((t) => t.id),
    [TEAM_B],
  );
});

test("a tool works in another GRANTED team when the call names it", async () => {
  // The team is an argument of the call, never a remembered setting: the
  // protocol is stateless, so there is nothing to switch and nothing to forget.
  const conn = await connect(["view"], [TEAM_A, TEAM_B]);
  const here = await mcp(conn.accessToken);
  assert.equal(toolJson(here.body).viewerTeam?.id, TEAM_A);

  const there = await mcp(conn.accessToken, { toolArgs: { team: "beta" } });
  assert.equal(there.status, 200, JSON.stringify(there.body));
  assert.equal(toolJson(there.body).viewerTeam?.id, TEAM_B);
});

test("a team the connection was NOT granted is refused, never swapped", async () => {
  // The silent swap is how an app was created in a team nobody chose. With
  // several teams in reach that mistake would leave no trace at all, so an
  // ungranted team has to come back as an error and not as another team's data.
  const conn = await connect(["view"], [TEAM_A]);
  const res = await mcp(conn.accessToken, { toolArgs: { team: "beta" } });
  const body = JSON.stringify(res.body);
  assert.match(body, /no access to the team/i, body);
  assert.ok(!body.includes(TEAM_B), "it answered about the other team anyway");
});

test("a deplo_ token still honours X-Deplo-Team", async () => {
  // The inverse, so the line above is proven to be about OAuth and not about a
  // header that quietly stopped working for everyone.
  const { raw } = await runWithIdentity(
    { userId: USER_1, teamId: TEAM_A },
    () => createToken({ name: "both", capabilities: ["view"] }),
  );
  const res = await mcp(raw, { team: "beta" });
  assert.equal(res.status, 200);
  assert.ok(
    JSON.stringify(res.body).includes(TEAM_B),
    JSON.stringify(res.body),
  );
});

test("a tool that runs outside GraphQL resolves the same identity", async () => {
  // `logs` reads a snapshot rather than running a GraphQL document, so it does
  // not get `runGraphql`'s
  // `runWithIdentity` for free, and the SDK handler runs OUTSIDE the scope this
  const conn = await connect(["view", "view_logs"]);
  const res = await mcp(conn.accessToken, {
    tool: "logs",
    toolArgs: { kind: "app", id: "prj_missing" },
  });
  const body = JSON.stringify(res.body);
  assert.ok(!body.includes("No active team"), body);
  assert.match(body, /No such app in this team/, body);
});

/* ------------------------------------------------------------------ */
/* 7. Static invariants                                                */
/* ------------------------------------------------------------------ */

test("the MCP route contains no authorization check of its own", async () => {
  // ADR-0021 §2 made mechanical: a capability check here is a bug, because the
  // dashboard would not get it. A runtime test can only prove today's behaviour;
  // this one stops a second gate ever being added.
  const { readFileSync } = await import("node:fs");
  const src = readFileSync("app/api/mcp/route.ts", "utf8");
  for (const forbidden of [
    "requireCapability(",
    "hasCapability(",
    "requireInstanceAdmin(",
  ])
    assert.ok(!src.includes(forbidden), `${forbidden} appeared in the route`);
});

test("better-auth's own MCP helpers are imported nowhere", async () => {
  // `withMcpAuth` / `getMcpSession` bypass Deplo's identity resolution entirely,
  // never read `client.disabled`, and return the row including the refresh
  // token. Four holes this file tests for individually, in one import.
  const { execSync } = await import("node:child_process");
  const hits = execSync(
    "grep -rl 'withMcpAuth\\|getMcpSession' --include=*.ts --include=*.tsx app lib components " +
      "| grep -v '\\.test\\.ts$' || true",
    { encoding: "utf8" },
  ).trim();
  assert.equal(hits, "", `better-auth MCP helpers imported in:\n${hits}`);
});
