import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { seedIdentity, TEAM_A, TEAM_B, USER_1 } from "./identity-test-helpers";
import { oauthConsent } from "../db/schema/auth";
import { runWithIdentity } from "../auth/request-context";
import {
  listConnectableTeamIds,
  listMcpConnections,
  mcpTokenConnected,
  mintMcpConnection,
} from "./mcp-clients";
import { createToken, listTokens, revokeToken } from "./tokens";
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
  // The mint requires a FRESH approval on file — the row `POST /oauth2/consent`
  // writes after verifying the provider's signature. Both people who approve in
  // this file therefore start with one; the tests that assert the requirement
  // delete it first.
  await consentRow(CLIENT, OWNER);
  await consentRow(CLIENT, MEMBER);
});

async function registerClientRow(clientId: string, name: string) {
  await pg.query(
    `insert into oauth_client (id, client_id, name, redirect_uris, created_at)
     values ($1, $2, $3, ARRAY['https://client.test/callback'], now())`,
    [`oc_${clientId}`, clientId, name],
  );
}

/**
 * Seeded the way the APPLICATION writes it — a JS `Date` through the driver —
 * and never with SQL `now()`. These are Better Auth's naive `timestamp` columns:
 * a driver-written value round-trips as the same instant, a `now()`-written one
 * comes back shifted by the server's offset (an hour, on the box this was
 * measured on). Seeding with `now()` makes a fresh consent look stale and the
 * test disagree with production for a reason that has nothing to do with the
 * code under test.
 */
async function consentRow(clientId: string, userId: string, ageMs = 0) {
  await db.insert(oauthConsent).values({
    id: `ocs_${clientId}_${userId}`,
    clientId,
    userId,
    scopes: ["openid"],
    createdAt: new Date(Date.now() - ageMs),
    updatedAt: new Date(Date.now() - ageMs),
  });
}

/** Make OWNER a full member of another team, with the same capabilities. */
async function grantOwnerIn(teamId: string) {
  await pg.query(
    `insert into memberships (id, user_id, team_id, role, created_at)
     values ('mem_owner_b2', $1, $2, 'owner', '2025-01-01T00:00:00.000Z')`,
    [OWNER, teamId],
  );
  await pg.query(
    `insert into membership_capabilities (membership_id, capability)
     select 'mem_owner_b2', capability from membership_capabilities
     where membership_id = $1`,
    [`mem_${OWNER}`],
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
  // A consent screen that trusted the OAuth `scope` parameter would grant what
  // the client asked for while showing the user something else. `scope` is not
  // even an argument here — Capabilities and OAuth scopes are different things.
  await as(OWNER, () =>
    mintMcpConnection({ clientId: CLIENT, capabilities: ["view"] }),
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

test("a connection is scoped to EXACTLY the active team, whoever the approver is", async () => {
  // The bug this pins reached production. A connection carries no
  // `X-Deplo-Team` — one endpoint serves one team (ADR-0021 §3) — so a scope
  // naming several teams has no way to say which one a request acts in, and
  // `authenticateToken` falls back to the FIRST reachable team: the oldest one
  // the approver belongs to. An agent then works in a team nobody chose. It
  // created an app in the wrong one before this was fixed.
  //
  // OWNER is a member of both teams here, so nothing but this rule keeps the
  // second one out.
  await pg.query(
    `insert into memberships (id, user_id, team_id, role, created_at)
     values ('mem_owner_b2', $1, $2, 'owner', '2025-01-01T00:00:00.000Z')`,
    [OWNER, TEAM_B],
  );
  await pg.query(
    `insert into membership_capabilities (membership_id, capability)
     select 'mem_owner_b2', capability from membership_capabilities
     where membership_id = $1`,
    [`mem_${OWNER}`],
  );

  await as(OWNER, () =>
    mintMcpConnection({ clientId: CLIENT, capabilities: ["view"] }),
  );
  const scope = (
    await pg.query(
      `select tt.team_id from api_token_teams tt
       join api_tokens t on t.id = tt.token_id
       where t.oauth_client_id = $1`,
      [CLIENT],
    )
  ).rows as { team_id: string }[];
  assert.deepEqual(
    scope.map((r) => r.team_id),
    [TEAM_A],
    "the connection reaches more than the team it was approved for",
  );
});

test("no approval on file mints nothing", async () => {
  // The hole this closes: the mint used to answer to a `client_id` and a session
  // and nothing else, so a link to `/oauth/consent?client_id=<mine>` was enough
  // to make somebody with the capabilities click Authorize and mint a live API
  // token bound to a client they had never heard of.
  await pg.query(`delete from oauth_consent`);
  await assert.rejects(
    as(OWNER, () =>
      mintMcpConnection({ clientId: CLIENT, capabilities: ["view"] }),
    ),
    /not pending any more/i,
  );
  assert.equal((await pg.query(`select id from api_tokens`)).rows.length, 0);
});

test("a stale approval mints nothing either", async () => {
  // Existence is not enough: a consent from an earlier connection would
  // otherwise be a standing permission to mint, and the crafted link would work
  // again for anyone who had ever connected that client.
  await pg.query(`delete from oauth_consent`);
  await consentRow(CLIENT, OWNER, 30 * 60 * 1000);
  await assert.rejects(
    as(OWNER, () =>
      mintMcpConnection({ clientId: CLIENT, capabilities: ["view"] }),
    ),
    /not pending any more/i,
  );
});

test("one person's approval does not let another mint", async () => {
  await pg.query(`delete from oauth_consent`);
  await consentRow(CLIENT, OWNER);
  await assert.rejects(
    as(MEMBER, () =>
      mintMcpConnection({ clientId: CLIENT, capabilities: ["view"] }),
    ),
    /not pending any more/i,
  );
});

test("a team that drifted between the screen and the submit is refused", async () => {
  // The screen says which team it showed; the server still decides. They only
  // ever disagree when something moved underneath — another tab, a half-finished
  // switch — and connecting a third party to a team nobody read is exactly the
  // failure this whole area already had once.
  await assert.rejects(
    as(OWNER, () =>
      mintMcpConnection({
        clientId: CLIENT,
        capabilities: ["view"],
        expectedTeamId: TEAM_B,
      }),
    ),
    /active team changed/i,
  );
  assert.equal((await pg.query(`select id from api_tokens`)).rows.length, 0);
});

test("another team may be granted, and then the connection really reaches it", async () => {
  // The multi-team rule. Naming a project of TEAM_B grants TEAM_B — a scope
  // reaches every team it touches, not only the ones ticked whole — so the same
  // gate has to pass there, and here it does.
  await grantOwnerIn(TEAM_B);
  await pg.query(
    `insert into projects (id, team_id, name, slug, created_at, updated_at)
     values ('prc_elsewhere', $1, 'Elsewhere', 'elsewhere',
             '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    [TEAM_B],
  );
  await as(OWNER, () =>
    mintMcpConnection({
      clientId: CLIENT,
      capabilities: ["view"],
      projectIds: ["prc_elsewhere"],
    }),
  );
  const reach = (
    await pg.query(
      `select p.team_id from api_token_projects tp
       join projects p on p.id = tp.project_id
       join api_tokens t on t.id = tp.token_id
       where t.oauth_client_id = $1`,
      [CLIENT],
    )
  ).rows as { team_id: string }[];
  assert.deepEqual(reach.map((r) => r.team_id), [TEAM_B]);
});

test("a team where you may not manage MCP access cannot be granted", async () => {
  // The gate is asked in the team it applies to. Holding it here says nothing
  // about there, and naming a team is letting an AI client into it.
  await grantOwnerIn(TEAM_B);
  await pg.query(
    `delete from membership_capabilities
     where membership_id = 'mem_owner_b2' and capability = 'manage_mcp'`,
  );
  await assert.rejects(
    as(OWNER, () =>
      mintMcpConnection({
        clientId: CLIENT,
        capabilities: ["view"],
        teamIds: [TEAM_A, TEAM_B],
      }),
    ),
    /may manage MCP access/i,
  );
  assert.equal((await pg.query(`select id from api_tokens`)).rows.length, 0);
});

test("a team with MCP switched off cannot be granted either", async () => {
  await grantOwnerIn(TEAM_B);
  await pg.query(`update teams set mcp_enabled = false where id = $1`, [TEAM_B]);
  await assert.rejects(
    as(OWNER, () =>
      mintMcpConnection({
        clientId: CLIENT,
        capabilities: ["view"],
        teamIds: [TEAM_A, TEAM_B],
      }),
    ),
    /turned off MCP access/i,
  );
});

/* ------------------------------------------------------------------ */
/* What the consent screen ticks                                       */
/* ------------------------------------------------------------------ */

test("the teams ticked by default are exactly the ones the mint would accept", async () => {
  await grantOwnerIn(TEAM_B);
  assert.deepEqual(
    (await as(OWNER, listConnectableTeamIds)).sort(),
    [TEAM_A, TEAM_B].sort(),
  );

  // The same two refusals the mint raises, so the screen never opens with a
  // tick on a team that would fail at Authorize.
  await pg.query(
    `delete from membership_capabilities
     where membership_id = 'mem_owner_b2' and capability = 'manage_mcp'`,
  );
  assert.deepEqual(await as(OWNER, listConnectableTeamIds), [TEAM_A]);
});

test("a team with MCP switched off is not ticked", async () => {
  await grantOwnerIn(TEAM_B);
  await pg.query(`update teams set mcp_enabled = false where id = $1`, [TEAM_B]);
  assert.deepEqual(await as(OWNER, listConnectableTeamIds), [TEAM_A]);
});

test("a team you are not in is never ticked", async () => {
  assert.deepEqual(await as(OWNER, listConnectableTeamIds), [TEAM_A]);
});

test("an attacker-length client name does not break the mint", async () => {
  // `createToken` refuses a name over 40 characters, and the name is chosen by
  // whoever registered the client.
  await registerClientRow("client_long", "N".repeat(200));
  await consentRow("client_long", OWNER);
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
  // Another PERSON, in the other team: whoever approved the connection may
  // always cut their own credential, so "another team" has to be someone else.
  await pg.query(
    `insert into memberships (id, user_id, team_id, role, created_at)
     values ('mem_member_b', $1, $2, 'owner', '2026-01-01T00:00:00.000Z')`,
    [MEMBER, TEAM_B],
  );
  await pg.query(
    `insert into membership_capabilities (membership_id, capability)
     select 'mem_member_b', capability from membership_capabilities
     where membership_id = $1`,
    [`mem_${MEMBER}`],
  );
  const fromB = await as(MEMBER, () => listMcpConnections(), TEAM_B);
  assert.deepEqual(fromB, []);
  await assert.rejects(
    as(MEMBER, () => revokeToken(tokenId), TEAM_B),
    /not found/i,
  );
});

test("your own connection follows you into your other teams", async () => {
  const { tokenId } = await as(OWNER, () =>
    mintMcpConnection({ clientId: CLIENT, capabilities: ["view"] }),
  );
  await grantOwnerIn(TEAM_B);
  // Settings → MCP is a TEAM screen and stays team-scoped. Settings → API tokens
  // is the person's OWN list, and losing sight of the credential your AI client
  // is using, with no team switcher on that page, is how it gets abandoned
  // rather than revoked.
  assert.deepEqual(await as(OWNER, () => listMcpConnections(), TEAM_B), []);
  assert.deepEqual(
    (await as(OWNER, () => listTokens(), TEAM_B)).map((t) => t.id),
    [tokenId],
  );
  await as(OWNER, () => revokeToken(tokenId), TEAM_B);
  assert.deepEqual(await as(OWNER, () => listTokens()), []);
});

test("a connection never carries the other teams it reaches", async () => {
  // Settings → MCP speaks about the active team and nothing else: whoever reads
  // it need not belong to the other teams the same consent was approved for, so
  // neither their names nor their ids may ride along in the row.
  await grantOwnerIn(TEAM_B);
  await as(OWNER, () =>
    mintMcpConnection({
      clientId: CLIENT,
      capabilities: ["view"],
      teamIds: [TEAM_A, TEAM_B],
    }),
  );
  const [row] = await as(OWNER, () => listMcpConnections());
  const json = JSON.stringify(row);
  assert.equal(row.teamId, TEAM_A);
  assert.ok(!json.includes(TEAM_B), "the other team's id leaked into the row");
  // Teams are seeded named after their slug.
  assert.ok(!json.includes("beta"), "the other team's name leaked into the row");
});

test("revoking from one team leaves the client connected to the others", async () => {
  await grantOwnerIn(TEAM_B);
  const { tokenId } = await as(OWNER, () =>
    mintMcpConnection({
      clientId: CLIENT,
      capabilities: ["view"],
      teamIds: [TEAM_A, TEAM_B],
    }),
  );

  await as(OWNER, () => revokeToken(tokenId), TEAM_B);

  const stillThere = await as(OWNER, () => listMcpConnections());
  assert.deepEqual(
    stillThere.map((c) => c.id),
    [tokenId],
    "team A never asked for the client to be disconnected",
  );
  assert.deepEqual(await as(OWNER, () => listMcpConnections(), TEAM_B), []);
  // The OAuth half is untouched: clearing it would sign the client out of team
  // A too, which is the whole thing this path exists to avoid.
  assert.equal(
    (await pg.query(`select id from oauth_consent where user_id = $1`, [OWNER]))
      .rows.length,
    1,
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

  for (const table of ["oauth_access_token", "oauth_refresh_token"]) {
    const rows = (await pg.query(`select id from ${table}`)).rows;
    assert.equal(rows.length, 0, `${table} kept a row after revocation`);
  }
  // Scoped to the person whose connection was revoked: another member's
  // approval of the same client is none of this revocation's business.
  const mine = (
    await pg.query(
      `select id from oauth_consent where client_id = $1 and user_id = $2`,
      [CLIENT, OWNER],
    )
  ).rows;
  assert.equal(mine.length, 0, "oauth_consent kept the revoked approval");
  const theirs = (
    await pg.query(`select id from oauth_consent where user_id = $1`, [MEMBER])
  ).rows;
  assert.equal(theirs.length, 1, "another member's approval was collateral");
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

/* ------------------------------------------------------------------ */
/* Bearer connections — the half this list used to be blind to          */
/* ------------------------------------------------------------------ */

/**
 * The gap these cover: before `mcp_last_used_at`, `listMcpConnections` joined
 * `oauth_client` and so could only ever see web connectors. A `deplo_` token
 * pasted into Claude Code drove the whole team through `/api/mcp` and appeared
 * on this screen nowhere, which made "who let an agent in, and how do I take it
 * away" answerable for half the clients and unanswerable for the other half.
 */

/** Mint an ordinary bearer token, the way the connect wizard does. */
async function bearer(name: string, userId = OWNER) {
  const { token } = await as(userId, () =>
    createToken({ name, capabilities: ["view", "deploy_apps"] }),
  );
  return token.id;
}

/** The stamp `/api/mcp` takes once a token really speaks the protocol. */
async function markSpokeMcp(tokenId: string) {
  await pg.query(`update api_tokens set mcp_last_used_at = now() where id = $1`, [
    tokenId,
  ]);
}

test("a bearer token that has spoken MCP is listed as a connection", async () => {
  const id = await bearer("Claude Code");
  await markSpokeMcp(id);

  const list = await as(OWNER, () => listMcpConnections());
  assert.equal(list.length, 1);
  assert.equal(list[0].id, id);
  assert.equal(list[0].kind, "token");
  // Its name is the one the person typed: there is no registered client row to
  // take a name from, and the protocol revision carries no `clientInfo`.
  assert.equal(list[0].clientName, "Claude Code");
  assert.equal(list[0].redirectOrigin, null);
  assert.ok(list[0].mcpLastUsedAt, "the MCP stamp did not reach the DTO");
});

test("a token that has never spoken MCP is not a connection", async () => {
  // The whole reason for a second column. This is a CI credential, and listing
  // it here would tell a company an AI agent is in their infrastructure when
  // none is.
  await bearer("Nightly CI");
  assert.deepEqual(await as(OWNER, () => listMcpConnections()), []);
});

test("an OAuth connector is still listed, and marked as a web app", async () => {
  await as(OWNER, () =>
    mintMcpConnection({ clientId: CLIENT, capabilities: ["view"] }),
  );
  const list = await as(OWNER, () => listMcpConnections());
  assert.equal(list.length, 1);
  assert.equal(list[0].kind, "web");
  assert.equal(list[0].clientName, "Claude");
  // Listed from the moment it is approved: approving IS the connection, and it
  // has made no call yet.
  assert.equal(list[0].mcpLastUsedAt, null);
});

test("both kinds share one list", async () => {
  const id = await bearer("Cursor");
  await markSpokeMcp(id);
  await as(OWNER, () =>
    mintMcpConnection({ clientId: CLIENT, capabilities: ["view"] }),
  );
  const list = await as(OWNER, () => listMcpConnections());
  assert.deepEqual(list.map((c) => c.kind).sort(), ["token", "web"]);
});

test("an expired token says so rather than vanishing", async () => {
  const id = await bearer("Old laptop");
  await markSpokeMcp(id);
  await pg.query(
    `update api_tokens set expires_at = now() - interval '1 day' where id = $1`,
    [id],
  );
  const list = await as(OWNER, () => listMcpConnections());
  assert.equal(list.length, 1, "an expired connection must stay visible");
  assert.equal(list[0].expired, true);
});

test("mcpTokenConnected answers only for a token that reaches this team", async () => {
  const id = await bearer("Claude Code");
  assert.equal(
    await as(OWNER, () => mcpTokenConnected(id)),
    false,
    "a token that has not called yet is not connected",
  );
  await markSpokeMcp(id);
  assert.equal(await as(OWNER, () => mcpTokenConnected(id)), true);

  // A token that does NOT reach the reading team answers FALSE, not an error:
  // an error would confirm the row exists to somebody with no business knowing
  // it does. MEMBER belongs only to TEAM_A, so a token they minted reaches only
  // TEAM_A — OWNER's own unscoped token would legitimately reach both teams
  // once they joined the second, which is a different (and correct) answer.
  const theirs = await bearer("Their Cursor", MEMBER);
  await markSpokeMcp(theirs);
  await grantOwnerIn(TEAM_B);
  assert.equal(
    await as(OWNER, () => mcpTokenConnected(theirs), TEAM_B),
    false,
    "a token that reaches only another team must not be visible here",
  );
  assert.equal(
    await as(OWNER, () => mcpTokenConnected(theirs)),
    true,
    "and it IS visible in the team it actually reaches",
  );
});

test("a bearer connection carries no other team's name or id", async () => {
  // The same leak check the OAuth rows get, for the shape that skips the
  // `oauth_client` join entirely.
  await grantOwnerIn(TEAM_B);
  const id = await bearer("Claude Code");
  await markSpokeMcp(id);
  const dump = JSON.stringify(await as(OWNER, () => listMcpConnections()));
  assert.ok(!dump.includes(TEAM_B), dump);
  assert.ok(!dump.includes("beta"), dump);
});
