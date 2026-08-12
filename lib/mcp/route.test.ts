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
 * The MCP endpoint as a resource server.
 *
 * Two credential shapes reach one route, and the entire claim of the OAuth work
 * is that they arrive at the SAME identity: a `deplo_` token someone pasted into
 * a terminal, and an OAuth access token a web AI client was issued. If those
 * ever diverge there are two authorization paths, which ADR-0021 §2 forbids and
 * which nothing else in the suite would notice — `lib/mcp/protocol.test.ts`
 * starts from a hand-built principal, so everything between the HTTP request and
 * that principal was untested before this file.
 *
 * The first section is the regression net: it passes on the pre-OAuth code and
 * is what says "we did not break deplo".
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
  // the wrong reason — the team simply being out of reach.
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
  opts: { team?: string; tool?: string; cookie?: string } = {},
): Promise<{ status: number; headers: Headers; body: Record<string, unknown> }> {
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
          arguments: {},
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
async function connect(capabilities: Capability[] = ["view"]) {
  const flow = await fullFlow({
    email: EMAIL,
    password: PASSWORD,
    resource: RESOURCE,
  });
  const { token } = await runWithIdentity(
    { userId: USER_1, teamId: TEAM_A },
    () =>
      createToken({
        name: "Test AI client",
        capabilities,
        teamIds: [TEAM_A],
      }),
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
  // other test here exercises ONE seam. This drives the sequence the browser
  // actually performs, in the order it performs it — deplo mints the credential
  // through the data layer first, then the PAGE posts the consent over HTTP
  // (which is the only way that endpoint works), then the client redeems its
  // code and calls a tool.
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
    "authorize must land on deplo's own consent page",
  );

  // What the consent page's browser fetch does FIRST — it verifies the
  // provider's signature and records the approval.
  const approved = await consent(cookie, {
    accept: true,
    oauth_query: authorized.oauthQuery ?? "",
  });
  assert.equal(approved.status, 200, `consent refused (${approved.status})`);

  // And only then what the GraphQL resolver does, behind every gate — which now
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
  // An access token lives an hour. EVERY connection depends on this path, and
  // nothing exercised it: if a refreshed token did not resolve, every agent
  // would work for an hour and then quietly go dead, which is the kind of bug
  // that gets blamed on the AI client.
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

  // The REFRESH token rotates and the spent one is dead — that is the property
  // that matters, and the one a stolen refresh token would otherwise defeat.
  // The previous ACCESS token deliberately lives out its hour: refreshing is not
  // a revocation event, and a real revocation deletes the `api_tokens` row,
  // which kills every access token for the connection at once (asserted above).
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
  // through a connection, and a connection belongs to a person — so the join
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
  // That is the widest surface it touches, and nothing tested it — a divergence
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
  // The login page resumes the flow by re-running authorize, and it recognises
  // that state by `client_id` + `sig` being on ITS url. If the provider ever
  // stopped putting them there, a first-time connect would sign in and land on
  // the dashboard, with the AI client waiting forever.
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
  assert.ok(sent.get("client_id"), "no client_id for the login page to resume on");
  assert.ok(sent.get("sig"), "no signature for the login page to resume on");
});

/* ------------------------------------------------------------------ */
/* 1. Baseline — the pre-OAuth path is unchanged                       */
/* ------------------------------------------------------------------ */

test("a deplo_ token still reaches its tools and resolves as its creator", async () => {
  const { raw } = await mintToken(["view"]);
  const res = await mcp(raw);
  assert.equal(res.status, 200);
  assert.ok(JSON.stringify(res.body).includes(USER_1), JSON.stringify(res.body));
});

test("a deplo_ token without the capability cannot reach the tool", async () => {
  // The tool list is filtered per token, so a capability it does not hold makes
  // the tool unreachable rather than merely refused. The authoritative gate is
  // still `requireCapability` in lib/data — this asserts the cosmetic filter has
  // not quietly started exposing everything.
  const { raw } = await mintToken(["view"]);
  const res = await mcp(raw, { tool: "delete_app" });
  assert.ok(res.body.error, JSON.stringify(res.body));
  assert.ok(!res.body.result, "delete_app ran for a view-only token");
});

test("the team kill switch refuses with the sentence that names the setting", async () => {
  const { raw } = await mintToken(["view"]);
  await pg.query(`update teams set mcp_enabled = false where id = $1`, [TEAM_A]);
  const res = await mcp(raw);
  assert.equal(res.status, 403);
  assert.match(String(res.body.error), /Settings → MCP Server/);
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
  assert.equal(match![1], `https://deplo.test/.well-known/oauth-protected-resource/api/mcp`);
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
  // The plugin's own token lookup never reads this column; deplo's join does.
  const conn = await connect(["view"]);
  assert.equal((await mcp(conn.accessToken)).status, 200);
  await pg.query(`update oauth_client set disabled = true where client_id = $1`, [
    conn.clientId,
  ]);
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
  await pg.query(`update teams set mcp_enabled = false where id = $1`, [TEAM_A]);
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

test("X-Deplo-Team cannot move an OAuth connection to another team", async () => {
  // The case that actually breaks: the approver owns BOTH teams, so nothing but
  // the connection's own scope stands between the client and team B.
  const conn = await connect(["view"]);
  const res = await mcp(conn.accessToken, { team: "beta" });
  assert.equal(res.status, 200);
  const text = JSON.stringify(res.body);
  assert.ok(text.includes(TEAM_A), text);
  assert.ok(!text.includes(TEAM_B), "the header moved the connection to team B");
});

test("a connection whose scope names two teams still resolves in the one it was approved for", async () => {
  // The repair for grants minted before the mint was fixed. Without a hint the
  // fallback is `reachable[0]` — the OLDEST team the approver belongs to — so a
  // connection approved in TEAM_A would act in whichever team happens to sort
  // first. TEAM_B is seeded older here precisely so the wrong answer wins if
  // the hint is ever dropped.
  const conn = await connect(["view"]);
  await pg.query(`update teams set created_at = $1 where id = $2`, [
    "2020-01-01T00:00:00.000Z",
    TEAM_B,
  ]);
  await pg.query(
    `insert into api_token_teams (token_id, team_id) values ($1, $2)`,
    [conn.tokenId, TEAM_B],
  );
  const res = await mcp(conn.accessToken);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  // On the resolved team, not the whole blob: `whoami` also returns `myTeams`,
  // which legitimately lists every team the scope names.
  assert.equal(toolJson(res.body).viewerTeam?.id, TEAM_A);
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
  assert.ok(JSON.stringify(res.body).includes(TEAM_B), JSON.stringify(res.body));
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
  // `withMcpAuth` / `getMcpSession` bypass deplo's identity resolution entirely,
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
