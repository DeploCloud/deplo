import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import type { PGlite } from "@electric-sql/pglite";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { seedIdentity, TEAM_A, USER_1 } from "../data/identity-test-helpers";
import { requireAuth, resetAuth } from "./better-auth";
import { rebuildOauthQuery } from "./oauth-query";
import {
  authServerMetadataResponse,
  protectedResourceResponse,
} from "./oauth-well-known";
import { GET as PATH_INSERTED_METADATA } from "@/app/.well-known/oauth-authorization-server/api/auth/route";
import {
  authorize,
  consent,
  exchange,
  fullFlow,
  pkcePair,
  registerClient,
  REGISTRATION_CREATED,
  signIn,
} from "./oauth-test-helpers";

/**
 * Deplo as an OAuth 2.1 authorization server. Everything here is driven over HTTP
 * through Better Auth's own handler, the way `lib/data/two-factor.test.ts` does,
 * because the risk this file covers is a REMOTE one.
 */

let db: TestDb;
let pg: PGlite;

const EMAIL = `${USER_1}@example.io`;
const PASSWORD = "password1";
const REDIRECT = "https://client.test/callback";
const BASE = "https://deplo.test";

const TRUNCATE = `truncate table
  oauth_access_token, oauth_refresh_token, oauth_consent, oauth_client,
  verification, session, account, api_tokens, membership_capabilities,
  memberships, users, teams, rate_limits
  restart identity cascade;`;

before(async () => {
  process.env.DEPLO_PUBLIC_URL = "https://deplo.test";
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
});

/* ------------------------------------------------------------------ */
/* The flow works at all                                               */
/* ------------------------------------------------------------------ */

test("a full authorization code flow issues an access token", async () => {
  const flow = await fullFlow({
    email: EMAIL,
    password: PASSWORD,
    resource: "https://deplo.test/api/mcp",
  });
  assert.ok(flow.accessToken.startsWith("dplo_at_"), flow.accessToken);
  assert.ok(flow.refreshToken?.startsWith("dplo_rt_"), "refresh token prefix");
});

test("the access token is stored hashed over the BARE secret", async () => {
  // The one contract that is invisible until it breaks: the plugin strips its prefix
  // before hashing, so `authenticateToken` must hash the bare secret.
  const flow = await fullFlow({ email: EMAIL, password: PASSWORD });
  const bare = flow.accessToken.slice("dplo_at_".length);
  const expected = createHash("sha256").update(bare).digest("hex");
  const rows = (await pg.query(`select token from oauth_access_token`))
    .rows as { token: string }[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].token, expected);
});

test("the consent endpoint REFUSES a server-side call, and refuses it wordlessly", async () => {
  // This is the bug that made Authorize a dead button, pinned from both ends.
  const reg = await registerClient();
  const cookie = await signIn(EMAIL, PASSWORD);
  const authorized = await authorize(cookie, {
    client_id: String(reg.body.client_id),
    redirect_uri: REDIRECT,
    response_type: "code",
    scope: "openid",
    state: "st",
    code_challenge: pkcePair().challenge,
    code_challenge_method: "S256",
  });
  const headers = new Headers();
  headers.set("cookie", cookie);

  const thrown = await requireAuth()
    .api.oauth2Consent({
      body: { accept: true, oauth_query: authorized.oauthQuery ?? "" },
      headers,
    })
    .then(
      () => null,
      (e: unknown) =>
        e as { message?: string; body?: { error_description?: string } },
    );

  assert.ok(
    thrown,
    "an in-process consent SUCCEEDED - re-read this test's note",
  );
  assert.equal(
    thrown!.body?.error_description,
    "request not found",
    "the refusal changed shape; check the provider still needs ctx.request",
  );
  assert.equal(
    thrown!.message,
    "",
    "if the provider learned to fill `message`, a UI showing it is no longer silent",
  );
});

test("the signed authorization query survives Next's searchParams round trip", async () => {
  // The bug this pins was invisible and total: the provider signs the whole
  // authorization query onto the consent URL, the page reads it back through Next's
  // `searchParams` (an object, with an ARRAY for the repeated `ba_param` keys), and
  const reg = await registerClient();
  const clientId = String(reg.body.client_id);
  const cookie = await signIn(EMAIL, PASSWORD);
  const { challenge } = pkcePair();
  const authorized = await authorize(cookie, {
    client_id: clientId,
    redirect_uri: REDIRECT,
    response_type: "code",
    scope: "openid",
    state: "st",
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  assert.ok(authorized.oauthQuery, "authorize produced no consent query");

  // Exactly what Next hands a page: repeated keys collapse into an array.
  const incoming = new URLSearchParams(authorized.oauthQuery!);
  assert.ok(
    incoming.getAll("ba_param").length > 1,
    "this test is pointless unless the query really repeats a key",
  );
  const searchParams: Record<string, string | string[]> = {};
  for (const key of new Set(incoming.keys())) {
    const all = incoming.getAll(key);
    searchParams[key] = all.length > 1 ? all : all[0];
  }

  const approved = await consent(cookie, {
    accept: true,
    oauth_query: rebuildOauthQuery(searchParams),
  });
  assert.equal(approved.status, 200, `consent refused (${approved.status})`);
  assert.ok(approved.url?.startsWith(REDIRECT), approved.url ?? "no url");
  assert.ok(
    new URL(approved.url!).searchParams.get("code"),
    "no code returned",
  );
});

test("dropping the repeated keys is what broke it", async () => {
  // The control for the test above: rebuild the way the first version did -
  // string values only, and the consent must be REFUSED. Without this, a
  // rebuild that silently stopped round-tripping would still look green.
  const reg = await registerClient();
  const clientId = String(reg.body.client_id);
  const cookie = await signIn(EMAIL, PASSWORD);
  const { challenge } = pkcePair();
  const authorized = await authorize(cookie, {
    client_id: clientId,
    redirect_uri: REDIRECT,
    response_type: "code",
    scope: "openid",
    state: "st",
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  const incoming = new URLSearchParams(authorized.oauthQuery!);
  const stringsOnly = new URLSearchParams();
  for (const key of new Set(incoming.keys())) {
    const all = incoming.getAll(key);
    if (all.length === 1) stringsOnly.set(key, all[0]);
  }
  const approved = await consent(cookie, {
    accept: true,
    oauth_query: stringsOnly.toString(),
  });
  assert.notEqual(approved.status, 200, "a mangled query was accepted");
});

test("a token cannot be requested for a resource Deplo does not serve", async () => {
  // GHSA-p2fr-6hmx-4528: the plugin validates `resource` but does not bind it to the
  // grant, so more than one valid audience lets a client aim a token at a resource
  // server it was not authorised for.
  await assert.rejects(
    fullFlow({
      email: EMAIL,
      password: PASSWORD,
      resource: "https://deplo.test/api/graphql",
    }),
  );
  await assert.rejects(
    fullFlow({
      email: EMAIL,
      password: PASSWORD,
      resource: "https://elsewhere.test/api/mcp",
    }),
  );
});

test("the audience allowlist has exactly one entry", async () => {
  // The runtime test above only proves today's list; this is what makes adding a
  // second audience a decision somebody has to argue for.
  const { readFileSync } = await import("node:fs");
  const src = readFileSync("lib/auth/better-auth.ts", "utf8");
  for (const key of ["resources", "clientRegistrationDefaultResources"]) {
    const line = new RegExp(`\\n\\s*${key}:\\s*\\[([^\\]]*)\\]`).exec(src);
    assert.ok(line, `${key} is no longer a literal list`);
    assert.equal(
      line![1].split(",").filter((t) => t.trim()).length,
      1,
      `a second audience in ${key} re-opens GHSA-p2fr-6hmx-4528`,
    );
  }
  // And enforcement stays ON. With it off, the link above is decorative: every
  // client could request every enabled resource.
  assert.ok(
    !/enforcePerClientResources:\s*false/.test(src),
    "per-client resource enforcement must stay on",
  );
});

test("a moved panel leaves exactly one requestable audience", async () => {
  // Better Auth 1.7.0 turned the audience list into ROWS, and seeds them
  // `insertOnly`.
  const { reconcileOAuthResources } = await import("./oauth-resources");
  const current = `${BASE}/api/mcp`;
  const stale = "https://the-old-address.test/api/mcp";

  // The state a move actually leaves behind: the old audience still enabled...
  await pg.query(
    `insert into oauth_resource (id, identifier, name, disabled) values ($1, $2, $3, false)
       on conflict (identifier) do update set disabled = false`,
    ["res_stale", stale, "old address"],
  );
  // .and the current one present but DISABLED, which is the A -> B -> A case: coming
  // back to an address you used before finds the row already there, and `insertOnly`
  // will not touch it.
  await pg.query(
    `insert into oauth_resource (id, identifier, name, disabled) values ($1, $2, $3, true)
       on conflict (identifier) do update set disabled = true`,
    ["res_current", current, "mcp"],
  );

  await reconcileOAuthResources();

  const rows = (
    await pg.query(`select identifier, disabled from oauth_resource`)
  ).rows as { identifier: string; disabled: boolean | null }[];
  assert.deepEqual(
    rows.filter((r) => !r.disabled).map((r) => r.identifier),
    [current],
    `exactly one audience may be requestable, got ${JSON.stringify(rows)}`,
  );
  // Disabled, not deleted: "which audience was valid last March" is an audit
  // question and these rows are the only thing that answers it.
  assert.ok(
    rows.some((r) => r.identifier === stale && r.disabled),
    "the old audience must be kept and disabled, not dropped",
  );

  await pg.query(`delete from oauth_resource where identifier = $1`, [stale]);
  await pg.query(
    `update oauth_resource set disabled = false where identifier = $1`,
    [current],
  );
});

test("the discovery documents agree on one issuer, and it resolves", async () => {
  // RFC 8414 §3.3 makes a client check that the `issuer` it reads back equals the
  // identifier it built the discovery URL from. An issuer WITH a path also moves its
  // metadata: §3.1 inserts the path after the well-known segment.
  const prm = (await (await protectedResourceResponse()).json()) as {
    authorization_servers: string[];
  };
  const as = (await (
    await authServerMetadataResponse(
      new Request(`${BASE}/.well-known/oauth-authorization-server`),
    )
  ).json()) as { issuer: string; grant_types_supported: string[] };

  assert.deepEqual(prm.authorization_servers, [as.issuer]);
  assert.equal(as.issuer, `${BASE}/api/auth`);

  // And the path-inserted document a client following that issuer would fetch.
  const inserted = await PATH_INSERTED_METADATA(
    new Request(`${BASE}/.well-known/oauth-authorization-server/api/auth`),
  );
  assert.equal(inserted.status, 200);
  assert.equal(
    ((await inserted.json()) as { issuer: string }).issuer,
    as.issuer,
  );

  // A grant Deplo will not honour must not be advertised: `client_credentials`
  // has no user, so it could never resolve to a connection.
  assert.deepEqual(as.grant_types_supported.sort(), [
    "authorization_code",
    "refresh_token",
  ]);
});

test("prompt=none is refused instead of silently re-issuing a code", async () => {
  // The provider honours it: with a consent on file it answers a top-level GET with a
  // 302 straight back to the client carrying a fresh code, no screen and no click.
  const reg = await registerClient();
  const clientId = String(reg.body.client_id);
  const cookie = await signIn(EMAIL, PASSWORD);
  const { challenge } = pkcePair();
  const params = {
    client_id: clientId,
    redirect_uri: REDIRECT,
    response_type: "code",
    scope: "openid",
    state: "st",
    code_challenge: challenge,
    code_challenge_method: "S256",
  };
  await consent(cookie, {
    accept: true,
    oauth_query: (await authorize(cookie, params)).oauthQuery ?? "",
  });

  const silent = await authorize(cookie, { ...params, prompt: "none" });
  assert.ok(
    !silent.location?.startsWith(REDIRECT),
    `a code was issued with no interaction: ${silent.location}`,
  );
});

/* ------------------------------------------------------------------ */
/* At rest                                                             */
/* ------------------------------------------------------------------ */

test("no issued credential is readable from the database", async () => {
  const flow = await fullFlow({ email: EMAIL, password: PASSWORD });
  const dump = JSON.stringify([
    (await pg.query(`select * from oauth_access_token`)).rows,
    (await pg.query(`select * from oauth_refresh_token`)).rows,
    (await pg.query(`select * from oauth_client`)).rows,
    (await pg.query(`select * from verification`)).rows,
  ]);
  for (const secret of [flow.accessToken, flow.refreshToken, flow.code]) {
    if (!secret) continue;
    assert.ok(
      !dump.includes(secret),
      "a live credential is sitting in the database in clear",
    );
  }
});

/* ------------------------------------------------------------------ */
/* PKCE                                                                */
/* ------------------------------------------------------------------ */

async function codeFor(
  cookie: string,
  clientId: string,
  extra: Record<string, string> = {},
): Promise<string> {
  const authorized = await authorize(cookie, {
    client_id: clientId,
    redirect_uri: REDIRECT,
    response_type: "code",
    scope: "openid",
    state: "st",
    ...extra,
  });
  const approved = await consent(cookie, {
    accept: true,
    ...(authorized.oauthQuery ? { oauth_query: authorized.oauthQuery } : {}),
  });
  assert.ok(approved.url, `consent produced no redirect (${approved.status})`);
  const code = new URL(approved.url!).searchParams.get("code");
  assert.ok(code, `no code in ${approved.url}`);
  return code!;
}

test("a wrong code_verifier is refused", async () => {
  const reg = await registerClient();
  const clientId = String(reg.body.client_id);
  const cookie = await signIn(EMAIL, PASSWORD);
  const { challenge } = pkcePair();
  const code = await codeFor(cookie, clientId, {
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  const res = await exchange({
    grant_type: "authorization_code",
    code,
    code_verifier: pkcePair().verifier,
    client_id: clientId,
    redirect_uri: REDIRECT,
  });
  assert.notEqual(res.status, 200);
  assert.ok(!res.body.access_token, "a wrong verifier minted a token");
});

test("a missing code_verifier is refused", async () => {
  const reg = await registerClient();
  const clientId = String(reg.body.client_id);
  const cookie = await signIn(EMAIL, PASSWORD);
  const { challenge } = pkcePair();
  const code = await codeFor(cookie, clientId, {
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  const res = await exchange({
    grant_type: "authorization_code",
    code,
    client_id: clientId,
    redirect_uri: REDIRECT,
  });
  assert.ok(!res.body.access_token, "a missing verifier minted a token");
});

test("code_challenge_method=plain is refused", async () => {
  // `plain` makes PKCE decorative: anyone holding the code holds the verifier.
  const reg = await registerClient();
  const clientId = String(reg.body.client_id);
  const cookie = await signIn(EMAIL, PASSWORD);
  const authorized = await authorize(cookie, {
    client_id: clientId,
    redirect_uri: REDIRECT,
    response_type: "code",
    scope: "openid",
    code_challenge: "a".repeat(43),
    code_challenge_method: "plain",
  });
  const landedOnConsent = authorized.location?.includes("/oauth/consent");
  assert.ok(!landedOnConsent, "a plain challenge reached the consent screen");
});

test("an authorization code is single-use", async () => {
  const reg = await registerClient();
  const clientId = String(reg.body.client_id);
  const cookie = await signIn(EMAIL, PASSWORD);
  const { verifier, challenge } = pkcePair();
  const code = await codeFor(cookie, clientId, {
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  const params = {
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    client_id: clientId,
    redirect_uri: REDIRECT,
  };
  const first = await exchange(params);
  assert.ok(first.body.access_token, "the first exchange should work");
  const second = await exchange(params);
  assert.ok(!second.body.access_token, "a replayed code minted a second token");
});

test("a code redeemed against a different redirect_uri is refused", async () => {
  const reg = await registerClient({
    redirect_uris: [REDIRECT, "https://client.test/other"],
  });
  const clientId = String(reg.body.client_id);
  const cookie = await signIn(EMAIL, PASSWORD);
  const { verifier, challenge } = pkcePair();
  const code = await codeFor(cookie, clientId, {
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  const res = await exchange({
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    client_id: clientId,
    redirect_uri: "https://client.test/other",
  });
  assert.ok(
    !res.body.access_token,
    "the redirect_uri was not bound to the code",
  );
});

/* ------------------------------------------------------------------ */
/* Redirects                                                           */
/* ------------------------------------------------------------------ */

test("redirect_uri must match exactly - a prefix or a sibling host is not a match", async () => {
  const reg = await registerClient();
  const clientId = String(reg.body.client_id);
  const cookie = await signIn(EMAIL, PASSWORD);
  for (const attempt of [
    "https://client.test/callback.evil.com",
    "https://client.test/callback/../../x",
    "https://client.test.evil.com/callback",
    "https://client.test/callbackX",
  ]) {
    const res = await authorize(cookie, {
      client_id: clientId,
      redirect_uri: attempt,
      response_type: "code",
      scope: "openid",
    });
    assert.ok(
      !res.location?.startsWith(attempt),
      `an unregistered redirect_uri was honoured: ${attempt}`,
    );
  }
});

test("a dangerous URL scheme cannot be registered as a redirect", async () => {
  for (const uri of [
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "data:text/html,<script>1</script>",
    "vbscript:msgbox(1)",
  ]) {
    const res = await registerClient({ redirect_uris: [uri] });
    assert.ok(
      res.status >= 400,
      `registration accepted a ${uri.split(":")[0]} redirect (HTTP ${res.status})`,
    );
  }
});

/* ------------------------------------------------------------------ */
/* Dynamic registration                                                */
/* ------------------------------------------------------------------ */

test("dynamic registration cannot grant itself a silent-approval flag", async () => {
  // Mass assignment from the registration body is how a self-registering client would
  // hand itself a consent-free path in.
  const refused = await registerClient({ skip_consent: true });
  assert.ok(refused.status >= 400, JSON.stringify(refused.body));

  // And a client cannot choose its own id, which would let it collide with one
  // somebody has already approved.
  const res = await registerClient({ client_id: "chosen-by-the-attacker" });
  assert.equal(res.status, REGISTRATION_CREATED, JSON.stringify(res.body));
  const clientId = String(res.body.client_id);
  assert.notEqual(clientId, "chosen-by-the-attacker");
  const rows = (
    await pg.query(
      `select skip_consent from oauth_client where client_id = $1`,
      [clientId],
    )
  ).rows as { skip_consent: boolean | null }[];
  assert.ok(!rows[0]?.skip_consent, "a client registered itself as trusted");
});

test("a freshly registered client reaches nothing until someone approves it", async () => {
  const res = await registerClient();
  const clientId = String(res.body.client_id);
  const tokens = (
    await pg.query(`select id from api_tokens where oauth_client_id = $1`, [
      clientId,
    ])
  ).rows;
  assert.equal(tokens.length, 0);
});

/* ------------------------------------------------------------------ */
/* Better Auth is not weakened                                         */
/* ------------------------------------------------------------------ */

test("/sign-in/email is refused over HTTP, and the session it would mint never exists", async () => {
  // The plugin's own sign-in skips every lock Deplo's does: the per-ACCOUNT rate
  // limit, the `failed_logins` alert, and the suspended-account refusal.
  const before = (await pg.query(`select id from session`)).rows.length;
  const res = await requireAuth().handler(
    new Request("http://localhost/api/auth/sign-in/email", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://localhost",
      },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    }),
  );
  assert.equal(res.status, 403);
  assert.equal(res.headers.getSetCookie().length, 0, "it set a session cookie");
  assert.equal(
    (await pg.query(`select id from session`)).rows.length,
    before,
    "it wrote a session row",
  );
});

test("sign-up is still refused over HTTP with the OAuth plugin loaded", async () => {
  // `disableSignUp` is one of the three settings better-auth.ts calls
  // load-bearing, and until now nothing asserted it.
  const res = await requireAuth().handler(
    new Request("http://localhost/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "intruder@example.io",
        password: "password1",
        name: "intruder",
      }),
    }),
  );
  assert.notEqual(res.status, 200);
  const rows = (
    await pg.query(`select id from users where email = 'intruder@example.io'`)
  ).rows;
  assert.equal(rows.length, 0, "the OAuth plugin opened a sign-up path");
});

test("/two-factor/* is still refused over HTTP with the OAuth plugin loaded", async () => {
  // Deliberately duplicates lib/data/two-factor.test.ts: the risk is plugin
  // ORDER, and this is the file where a plugin was added.
  const res = await requireAuth().handler(
    new Request("http://localhost/api/auth/two-factor/enable", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: PASSWORD }),
    }),
  );
  assert.equal(res.status, 403);
});

test("the two-factor gate does not catch the OAuth endpoints", async () => {
  const res = await registerClient();
  assert.equal(res.status, REGISTRATION_CREATED, JSON.stringify(res.body));
});

test("a normal sign-in still works and still returns a session row", async () => {
  const cookie = await signIn(EMAIL, PASSWORD);
  assert.ok(cookie.includes("deplo.session_token"), cookie);
  const rows = (await pg.query(`select user_id from session`)).rows as {
    user_id: string;
  }[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].user_id, USER_1);
});

test("userinfo returns only profile claims, never the users row", async () => {
  // Better Auth's `user` model IS the control-plane `users` table (ADR-0014), so
  // a generous default here ships is_instance_admin and friends to every client
  // that ever registered.
  const flow = await fullFlow({
    email: EMAIL,
    password: PASSWORD,
    scope: "openid profile email",
  });
  const res = await requireAuth().handler(
    new Request("http://localhost/api/auth/oauth2/userinfo", {
      headers: { authorization: `Bearer ${flow.accessToken}` },
    }),
  );
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  for (const leak of [
    "is_instance_admin",
    "isInstanceAdmin",
    "suspended",
    "role",
    "password_hash",
  ])
    assert.ok(!(leak in body), `userinfo leaked ${leak}`);
  assert.equal(body.sub, USER_1);
});

test("the team the seed made is untouched by any of this", async () => {
  const rows = (await pg.query(`select id from teams where id = $1`, [TEAM_A]))
    .rows;
  assert.equal(rows.length, 1);
});
