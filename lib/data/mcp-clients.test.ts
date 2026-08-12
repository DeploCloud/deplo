import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { seedIdentity, TEAM_A, TEAM_B, USER_1 } from "./identity-test-helpers";
import { runWithIdentity } from "../auth/request-context";
import { listMcpConnections, mintMcpConnection } from "./mcp-clients";
import { listTokens, revokeToken } from "./tokens";
import { listActivity } from "./activity";
import type { Capability } from "../types";

/**
 * The consent decision.
 *
 * This is the only place in deplo where an authorization decision CREATES a
 * credential, which makes it the one function where getting a gate wrong hands
 * a third party standing access rather than merely letting a request through.
 *
 * Everything here drives `mintMcpConnection` — the gates plus the mint, split
 * from the OAuth handshake precisely so it can be exercised without a browser.
 */

let db: TestDb;
let pg: PGlite;

const OWNER = USER_1;
const MEMBER = "user_2";
const CLIENT = "client_abc";

const TRUNCATE = `truncate table
  oauth_access_token, oauth_refresh_token, oauth_consent, oauth_client,
  api_tokens, activities, membership_capabilities, memberships, users, teams
  restart identity cascade;`;

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
});

after(async () => {
  __resetTestDb();
  await pg.close();
});

/** Both capabilities the door needs, and nothing dangerous beyond them. */
const CONNECTOR: Capability[] = [
  "view",
  "manage_mcp",
  "manage_tokens",
  "deploy_apps",
];

beforeEach(async () => {
  await pg.exec(TRUNCATE);
  await seedIdentity(db, {
    teams: [
      { id: TEAM_A, slug: "alpha" },
      { id: TEAM_B, slug: "beta" },
    ],
    users: [
      { id: OWNER, teamId: TEAM_A, role: "owner" },
      { id: MEMBER, teamId: TEAM_A, role: "member", capabilities: CONNECTOR },
    ],
  });
  await registerClientRow(CLIENT, "Claude");
});

async function registerClientRow(clientId: string, name: string) {
  await pg.query(
    `insert into oauth_client (id, client_id, name, redirect_uris, created_at)
     values ($1, $2, $3, ARRAY['https://client.test/callback'], now())`,
    [`oc_${clientId}`, clientId, name],
  );
}

function as<T>(userId: string, fn: () => Promise<T>, teamId = TEAM_A) {
  return runWithIdentity({ userId, teamId }, fn);
}

/* ------------------------------------------------------------------ */
/* Privilege escalation                                                */
/* ------------------------------------------------------------------ */

test("a connection cannot be granted a capability its approver does not hold", async () => {
  await assert.rejects(
    as(MEMBER, () =>
      mintMcpConnection({
        clientId: CLIENT,
        capabilities: ["view", "delete_apps"],
      }),
    ),
    /permission|hold yourself|only give/i,
  );
});

test("a connection is never granted instance administration", async () => {
  // Structural rather than a check: the token is always scoped to the chosen
  // team, and a scoped token is refused instance administration outright. Run it
  // as the instance ADMIN, where a slip would actually be reachable.
  await as(OWNER, () =>
    mintMcpConnection({ clientId: CLIENT, capabilities: ["view"] }),
  );
  const rows = (
    await pg.query(
      `select instance_admin, scoped from api_tokens where oauth_client_id = $1`,
      [CLIENT],
    )
  ).rows as { instance_admin: boolean; scoped: boolean }[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].instance_admin, false);
  assert.equal(rows[0].scoped, true);
});

test("re-approving replaces the connection instead of widening the old token", async () => {
  const first = await as(OWNER, () =>
    mintMcpConnection({ clientId: CLIENT, capabilities: ["view"] }),
  );
  const second = await as(OWNER, () =>
    mintMcpConnection({
      clientId: CLIENT,
      capabilities: ["view", "deploy_apps"],
    }),
  );
  assert.notEqual(first.tokenId, second.tokenId);
  // The old row is GONE, not quietly holding the new permissions.
  const old = (
    await pg.query(`select id from api_tokens where id = $1`, [first.tokenId])
  ).rows;
  assert.equal(old.length, 0);
  const live = (
    await pg.query(`select id from api_tokens where oauth_client_id = $1`, [
      CLIENT,
    ])
  ).rows;
  assert.equal(live.length, 1, "re-approving left two indistinguishable rows");
});

test("the minted capabilities are the ones the form submitted, never the client's ask", async () => {
  // A consent screen that trusted the `scope` parameter would grant what the
  // client asked for while showing the user something else.
  await as(OWNER, () =>
    mintMcpConnection({
      clientId: CLIENT,
      capabilities: ["view"],
      scope: "openid delete_apps manage_members",
    }),
  );
  const caps = (
    await pg.query(
      `select capability from api_token_capabilities c
       join api_tokens t on t.id = c.token_id
       where t.oauth_client_id = $1`,
      [CLIENT],
    )
  ).rows as { capability: string }[];
  assert.deepEqual(
    caps.map((c) => c.capability).sort(),
    ["view"],
  );
});

test("an attacker-length client name does not break the mint", async () => {
  // `createToken` refuses a name over 40 characters, and the name is chosen by
  // whoever registered the client.
  await registerClientRow("client_long", "N".repeat(200));
  await as(OWNER, () =>
    mintMcpConnection({ clientId: "client_long", capabilities: ["view"] }),
  );
  const rows = (
    await pg.query(`select name from api_tokens where oauth_client_id = $1`, [
      "client_long",
    ])
  ).rows as { name: string }[];
  assert.equal(rows.length, 1);
  assert.ok(rows[0].name.length <= 40, rows[0].name);
});

/* ------------------------------------------------------------------ */
/* The door                                                            */
/* ------------------------------------------------------------------ */

test("approving needs manage_mcp", async () => {
  await pg.query(
    `delete from membership_capabilities
     where membership_id = $1 and capability = 'manage_mcp'`,
    [`mem_${MEMBER}`],
  );
  await assert.rejects(
    as(MEMBER, () =>
      mintMcpConnection({ clientId: CLIENT, capabilities: ["view"] }),
    ),
    /permission|not allowed/i,
  );
});

test("approving needs manage_tokens as well, not only manage_mcp", async () => {
  // Both, in both directions: one `requireCapability` call can only carry one,
  // and this pair is what forces the second gate to exist.
  await pg.query(
    `delete from membership_capabilities
     where membership_id = $1 and capability = 'manage_tokens'`,
    [`mem_${MEMBER}`],
  );
  await assert.rejects(
    as(MEMBER, () =>
      mintMcpConnection({ clientId: CLIENT, capabilities: ["view"] }),
    ),
    /permission|not allowed/i,
  );
  const rows = (await pg.query(`select id from api_tokens`)).rows;
  assert.equal(rows.length, 0, "a token was minted despite the refusal");
});

test("the team kill switch blocks the DOOR, not only the request", async () => {
  // Otherwise turning MCP off leaves connections that resume the moment it
  // flips back, which is not what an operator turning it off believes.
  await pg.query(`update teams set mcp_enabled = false where id = $1`, [TEAM_A]);
  await assert.rejects(
    as(OWNER, () =>
      mintMcpConnection({ clientId: CLIENT, capabilities: ["view"] }),
    ),
    /turned off MCP access/i,
  );
  assert.equal((await pg.query(`select id from api_tokens`)).rows.length, 0);
});

test("an unmet two-factor policy refuses the approval", async () => {
  await pg.query(`update teams set require_two_factor = true where id = $1`, [
    TEAM_A,
  ]);
  await assert.rejects(
    as(OWNER, () =>
      mintMcpConnection({ clientId: CLIENT, capabilities: ["view"] }),
    ),
  );
  assert.equal((await pg.query(`select id from api_tokens`)).rows.length, 0);
});

test("an unknown client mints nothing and confirms nothing", async () => {
  await assert.rejects(
    as(OWNER, () =>
      mintMcpConnection({ clientId: "never-registered", capabilities: ["view"] }),
    ),
    /not registered/i,
  );
  assert.equal((await pg.query(`select id from api_tokens`)).rows.length, 0);
});

test("a disabled client cannot be approved", async () => {
  await pg.query(`update oauth_client set disabled = true where client_id = $1`, [
    CLIENT,
  ]);
  await assert.rejects(
    as(OWNER, () =>
      mintMcpConnection({ clientId: CLIENT, capabilities: ["view"] }),
    ),
    /not registered/i,
  );
});

/* ------------------------------------------------------------------ */
/* Listing, revocation, cross-team                                     */
/* ------------------------------------------------------------------ */

test("a connection is listed with the permissions it holds NOW", async () => {
  await as(OWNER, () =>
    mintMcpConnection({
      clientId: CLIENT,
      capabilities: ["view", "deploy_apps"],
    }),
  );
  const list = await as(OWNER, () => listMcpConnections());
  assert.equal(list.length, 1);
  assert.equal(list[0].clientName, "Claude");
  assert.equal(list[0].username, USER_1);
  assert.equal(list[0].redirectOrigin, "https://client.test");
  assert.deepEqual(list[0].capabilities.sort(), ["deploy_apps", "view"]);
});

test("another team neither sees nor revokes this team's connection", async () => {
  const { tokenId } = await as(OWNER, () =>
    mintMcpConnection({ clientId: CLIENT, capabilities: ["view"] }),
  );
  await pg.query(
    `insert into memberships (id, user_id, team_id, role, created_at)
     values ('mem_owner_b', $1, $2, 'owner', '2026-01-01T00:00:00.000Z')`,
    [OWNER, TEAM_B],
  );
  await pg.query(
    `insert into membership_capabilities (membership_id, capability)
     select 'mem_owner_b', capability from membership_capabilities
     where membership_id = $1`,
    [`mem_${OWNER}`],
  );
  const fromB = await as(OWNER, () => listMcpConnections(), TEAM_B);
  assert.deepEqual(fromB, []);
  await assert.rejects(
    as(OWNER, () => revokeToken(tokenId), TEAM_B),
    /not found/i,
  );
});

test("revoking the connection also clears its OAuth rows", async () => {
  const { tokenId } = await as(OWNER, () =>
    mintMcpConnection({ clientId: CLIENT, capabilities: ["view"] }),
  );
  // A refresh token would otherwise mint a fresh access token an hour later, and
  // a surviving consent would let the client re-authorize with no screen.
  await pg.query(
    `insert into oauth_refresh_token
       (id, token, client_id, user_id, expires_at, created_at, scopes)
     values ('ort_1', 'h1', $1, $2, now() + interval '1 day', now(), ARRAY['openid'])`,
    [CLIENT, OWNER],
  );
  await pg.query(
    `insert into oauth_access_token
       (id, token, client_id, user_id, expires_at, created_at, scopes)
     values ('oat_1', 'h2', $1, $2, now() + interval '1 hour', now(), ARRAY['openid'])`,
    [CLIENT, OWNER],
  );
  await pg.query(
    `insert into oauth_consent (id, client_id, user_id, scopes, created_at)
     values ('ocs_1', $1, $2, ARRAY['openid'], now())`,
    [CLIENT, OWNER],
  );

  await as(OWNER, () => revokeToken(tokenId));

  for (const table of [
    "oauth_access_token",
    "oauth_refresh_token",
    "oauth_consent",
  ]) {
    const rows = (await pg.query(`select id from ${table}`)).rows;
    assert.equal(rows.length, 0, `${table} kept a row after revocation`);
  }
});

test("revoking one person's connection leaves another's to the same client alone", async () => {
  const mine = await as(OWNER, () =>
    mintMcpConnection({ clientId: CLIENT, capabilities: ["view"] }),
  );
  const theirs = await as(MEMBER, () =>
    mintMcpConnection({ clientId: CLIENT, capabilities: ["view"] }),
  );
  assert.notEqual(mine.tokenId, theirs.tokenId);
  await as(OWNER, () => revokeToken(mine.tokenId));
  const left = (
    await pg.query(`select id from api_tokens where oauth_client_id = $1`, [
      CLIENT,
    ])
  ).rows as { id: string }[];
  assert.deepEqual(
    left.map((r) => r.id),
    [theirs.tokenId],
  );
});

/* ------------------------------------------------------------------ */
/* Audit and secret hygiene                                            */
/* ------------------------------------------------------------------ */

test("approving writes one activity entry naming the client and the approver", async () => {
  await as(OWNER, () =>
    mintMcpConnection({ clientId: CLIENT, capabilities: ["view"] }),
  );
  const entries = await as(OWNER, () => listActivity());
  const connected = entries.filter((e) => /Connected Claude/.test(e.message));
  assert.equal(connected.length, 1, JSON.stringify(entries));
  assert.equal(connected[0].actor, USER_1);
});

test("the raw token never reaches the activity trail or the connection DTO", async () => {
  // `createToken` returns a live bearer that this flow drops on the floor. If it
  // ever leaked, revoking the OAuth connection would leave it working.
  await as(OWNER, () =>
    mintMcpConnection({ clientId: CLIENT, capabilities: ["view"] }),
  );
  const dump = JSON.stringify([
    await as(OWNER, () => listActivity()),
    await as(OWNER, () => listMcpConnections()),
    await as(OWNER, () => listTokens()),
  ]);
  // The 12-character `prefix` is shown on purpose (`deplo_abc1••••••••`), so the
  // thing to hunt is a FULL secret: 24 random bytes as base64url is 32 chars.
  const fullSecret = /deplo_[A-Za-z0-9_-]{20,}/.exec(dump);
  assert.equal(fullSecret, null, `a raw bearer escaped: ${fullSecret?.[0]}`);
  assert.ok(!dump.includes("token_hash"), dump.slice(0, 200));
});

/* ------------------------------------------------------------------ */
/* Static invariants                                                   */
/* ------------------------------------------------------------------ */

test("the consent path mints through createToken and never inserts a token itself", async () => {
  // The highest-value test in this file. Every runtime assertion above proves
  // the mint is correct TODAY; this proves there is no second construction site
  // that could drift away from `withinActor` next month.
  const { readFileSync } = await import("node:fs");
  const src = readFileSync("lib/data/mcp-clients.ts", "utf8");
  for (const forbidden of [
    "insert(apiTokens",
    "insert(apiTokenCapabilities",
    '"api_tokens"',
  ])
    assert.ok(
      !src.includes(forbidden),
      `${forbidden} in mcp-clients.ts — the mint must go through createToken`,
    );
  assert.ok(src.includes("createToken("), "the mint stopped using createToken");
});

test("the consent path never names instance administration in code", async () => {
  // Comments are stripped first: the docblock explaining WHY instance
  // administration is unreachable is the thing we most want kept.
  const { readFileSync } = await import("node:fs");
  const code = readFileSync("lib/data/mcp-clients.ts", "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  for (const forbidden of ["instanceAdmin", "instance_admin"])
    assert.ok(!code.includes(forbidden), `${forbidden} is reachable from consent`);
});

test("the connection appears in the API tokens list, marked", async () => {
  // One screen still answers "who can act in this team".
  await as(OWNER, () =>
    mintMcpConnection({ clientId: CLIENT, capabilities: ["view"] }),
  );
  const tokens = await as(OWNER, () => listTokens());
  assert.equal(tokens.length, 1);
  assert.equal(tokens[0].oauthClientName, "Claude");
});
