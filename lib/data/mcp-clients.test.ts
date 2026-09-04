import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { seedIdentity, TEAM_A, TEAM_B, USER_1 } from "./identity-test-helpers";
import { oauthConsent } from "../db/schema/auth";
import { runWithIdentity } from "../auth/request-context";
import {
  countMcpAgents,
  listConnectableTeamIds,
  listMcpTeams,
  mcpTokenConnected,
  mintMcpConnection,
} from "./mcp-clients";
import { createToken, listTokens, revokeToken } from "./tokens";
import { listActivity } from "./activity";
import type { Capability } from "../types";

/**
 * The consent decision.
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
  // The mint requires a FRESH approval on file - the row `POST /oauth2/consent`
  // writes after verifying the provider's signature.
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
 * Seeded the way the APPLICATION writes it, a JS `Date` through the driver, and
 * never with SQL `now()`.
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
  // The consent path never names it, so it cannot be asked for. Run it as the
  // instance ADMIN, where a slip would actually be reachable.
  await as(OWNER, () =>
    mintMcpConnection({ clientId: CLIENT, capabilities: ["view"] }),
  );
  const rows = (
    await pg.query(
      `select instance_admin from api_tokens where oauth_client_id = $1`,
      [CLIENT],
    )
  ).rows as { instance_admin: boolean }[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].instance_admin, false);
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
  // even an argument here - Capabilities and OAuth scopes are different things.
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
  assert.deepEqual(caps.map((c) => c.capability).sort(), ["view"]);
});

test("naming nothing means every team you may connect agents to, live", async () => {
  await grantOwnerIn(TEAM_B);
  await as(OWNER, () =>
    mintMcpConnection({ clientId: CLIENT, capabilities: ["view"] }),
  );
  const scope = (
    await pg.query(
      `select t.scoped, tt.team_id from api_tokens t
       left join api_token_teams tt on tt.token_id = t.id
       where t.oauth_client_id = $1`,
      [CLIENT],
    )
  ).rows as { scoped: boolean; team_id: string | null }[];
  assert.deepEqual(scope, [{ scoped: false, team_id: null }]);
  const [token] = await as(OWNER, () => listTokens());
  assert.deepEqual(token.teamsReached.map((t) => t.id).sort(), [
    TEAM_A,
    TEAM_B,
  ]);
  // Where it may ACT is read live: take the permission away in one team and
  // the connection is refused there, with nothing on the token touched.
  await pg.query(
    `delete from membership_capabilities
     where membership_id = 'mem_owner_b2' and capability = 'manage_mcp'`,
  );
  const teams = await as(OWNER, () => listMcpTeams());
  assert.deepEqual(teams.map((t) => [t.id, t.canConnect]).sort(), [
    [TEAM_A, true],
    [TEAM_B, false],
  ]);
});

test("no approval on file mints nothing", async () => {
  // The hole this closes: the mint used to answer to a `client_id` and a session and
  // nothing else, so a link to `/oauth/consent?client_id=<mine>` was enough to make
  // somebody with the capabilities click Authorize and mint a live API token bound to
  // a client they had never heard of.
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
  // The screen says which team it showed; the server still decides.
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
  // The multi-team rule. Naming a project of TEAM_B grants TEAM_B - a scope
  // reaches every team it touches, not only the ones ticked whole, so the same
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
  assert.deepEqual(
    reach.map((r) => r.team_id),
    [TEAM_B],
  );
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
    /may connect AI agents/i,
  );
  assert.equal((await pg.query(`select id from api_tokens`)).rows.length, 0);
});

test("a team with MCP switched off cannot be granted either", async () => {
  await grantOwnerIn(TEAM_B);
  await pg.query(`update teams set mcp_enabled = false where id = $1`, [
    TEAM_B,
  ]);
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
  await pg.query(`update teams set mcp_enabled = false where id = $1`, [
    TEAM_B,
  ]);
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
  await pg.query(`update teams set mcp_enabled = false where id = $1`, [
    TEAM_A,
  ]);
  await assert.rejects(
    as(OWNER, () =>
      mintMcpConnection({ clientId: CLIENT, capabilities: ["view"] }),
    ),
    /turn MCP on/i,
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
      mintMcpConnection({
        clientId: "never-registered",
        capabilities: ["view"],
      }),
    ),
    /not registered/i,
  );
  assert.equal((await pg.query(`select id from api_tokens`)).rows.length, 0);
});

test("a disabled client cannot be approved", async () => {
  await pg.query(
    `update oauth_client set disabled = true where client_id = $1`,
    [CLIENT],
  );
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

test("a connection is listed to its owner with the permissions it holds NOW", async () => {
  await as(OWNER, () =>
    mintMcpConnection({
      clientId: CLIENT,
      capabilities: ["view", "deploy_apps"],
    }),
  );
  const list = await as(OWNER, () => listTokens());
  assert.equal(list.length, 1);
  assert.equal(list[0].oauthClientName, "Claude");
  assert.equal(list[0].mcp, true);
  assert.deepEqual(list[0].capabilities.slice().sort(), [
    "deploy_apps",
    "view",
  ]);
});

test("another person neither sees nor revokes the connection, but the team counts it", async () => {
  const { tokenId } = await as(OWNER, () =>
    mintMcpConnection({ clientId: CLIENT, capabilities: ["view"] }),
  );
  assert.deepEqual(await as(MEMBER, () => listTokens()), []);
  await assert.rejects(
    as(MEMBER, () => revokeToken(tokenId)),
    /not found/i,
  );
  // A number is all the team gets: enough to know an agent is here.
  assert.equal(await as(MEMBER, () => countMcpAgents()), 1);
});

test("your own connection follows you into your other teams", async () => {
  const { tokenId } = await as(OWNER, () =>
    mintMcpConnection({ clientId: CLIENT, capabilities: ["view"] }),
  );
  await grantOwnerIn(TEAM_B);
  assert.deepEqual(
    (await as(OWNER, () => listTokens(), TEAM_B)).map((t) => t.id),
    [tokenId],
  );
  await as(OWNER, () => revokeToken(tokenId), TEAM_B);
  assert.deepEqual(await as(OWNER, () => listTokens()), []);
});

test("the agent count is per team, and only counts where the owner may connect", async () => {
  await grantOwnerIn(TEAM_B);
  await as(OWNER, () =>
    mintMcpConnection({ clientId: CLIENT, capabilities: ["view"] }),
  );
  assert.equal(await as(OWNER, () => countMcpAgents()), 1);
  assert.equal(await as(OWNER, () => countMcpAgents(), TEAM_B), 1);
  // Not a member who may use tokens there any more: not counted there.
  await pg.query(
    `delete from membership_capabilities
     where membership_id = 'mem_owner_b2' and capability = 'manage_tokens'`,
  );
  assert.equal(await as(OWNER, () => countMcpAgents(), TEAM_B), 0);
  assert.equal(await as(OWNER, () => countMcpAgents()), 1);
});

test("revoking from one team disconnects the client from all of them", async () => {
  await grantOwnerIn(TEAM_B);
  const { tokenId } = await as(OWNER, () =>
    mintMcpConnection({
      clientId: CLIENT,
      capabilities: ["view"],
      teamIds: [TEAM_A, TEAM_B],
    }),
  );

  await as(OWNER, () => revokeToken(tokenId), TEAM_B);

  assert.equal(await as(OWNER, () => countMcpAgents()), 0);
  assert.equal(await as(OWNER, () => countMcpAgents(), TEAM_B), 0);
  // The OAuth half goes with it: a surviving consent would let the client
  // re-authorize with no screen, which is not what Revoke promised.
  assert.equal(
    (await pg.query(`select id from oauth_consent where user_id = $1`, [OWNER]))
      .rows.length,
    0,
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
      `${forbidden} in mcp-clients.ts - the mint must go through createToken`,
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
    assert.ok(
      !code.includes(forbidden),
      `${forbidden} is reachable from consent`,
    );
});

test("the connection appears in the API tokens list, marked", async () => {
  // One screen still answers "who can act in this team".
  await as(OWNER, () =>
    mintMcpConnection({ clientId: CLIENT, capabilities: ["view"] }),
  );
  const tokens = await as(OWNER, () => listTokens());
  assert.equal(tokens.length, 1);
  assert.equal(tokens[0].oauthClientName, "Claude");
  assert.equal(tokens[0].mcp, true, "the robot mark did not reach the list");
});

/* ------------------------------------------------------------------ */
/* Bearer connections - the half this list used to be blind to          */
/* ------------------------------------------------------------------ */

/**
 * A bearer token has no registered client row: what makes it an agent is having
 * spoken the protocol.
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
  await pg.query(
    `update api_tokens set mcp_last_used_at = now() where id = $1`,
    [tokenId],
  );
}

test("a bearer token that has spoken MCP counts as an agent, and is marked", async () => {
  const id = await bearer("Claude Code");
  await markSpokeMcp(id);
  assert.equal(await as(OWNER, () => countMcpAgents()), 1);
  const [token] = await as(OWNER, () => listTokens());
  assert.equal(token.id, id);
  assert.equal(token.oauthClientName, null);
  assert.equal(token.mcp, true);
});

test("a token that has never spoken MCP is not an agent", async () => {
  // This is a CI credential, and counting it would tell a company an AI agent
  // is in their infrastructure when none is.
  await bearer("Nightly CI");
  assert.equal(await as(OWNER, () => countMcpAgents()), 0);
  assert.equal((await as(OWNER, () => listTokens()))[0].mcp, false);
});

test("an OAuth connector counts from the moment it is approved", async () => {
  await as(OWNER, () =>
    mintMcpConnection({ clientId: CLIENT, capabilities: ["view"] }),
  );
  assert.equal(await as(OWNER, () => countMcpAgents()), 1);
});

test("both kinds count, across every member", async () => {
  const id = await bearer("Cursor", MEMBER);
  await markSpokeMcp(id);
  await as(OWNER, () =>
    mintMcpConnection({ clientId: CLIENT, capabilities: ["view"] }),
  );
  assert.equal(await as(OWNER, () => countMcpAgents()), 2);
});

test("an expired token is not counted, but its owner still sees why it stopped", async () => {
  const id = await bearer("Old laptop");
  await markSpokeMcp(id);
  await pg.query(
    `update api_tokens set expires_at = now() - interval '1 day' where id = $1`,
    [id],
  );
  assert.equal(await as(OWNER, () => countMcpAgents()), 0);
  const [token] = await as(OWNER, () => listTokens());
  assert.equal(token.expired, true);
});

test("mcpTokenConnected answers only for your own token", async () => {
  const id = await bearer("Claude Code");
  assert.equal(
    await as(OWNER, () => mcpTokenConnected(id)),
    false,
    "a token that has not called yet is not connected",
  );
  await markSpokeMcp(id);
  assert.equal(await as(OWNER, () => mcpTokenConnected(id)), true);

  // Somebody else's token answers FALSE, not an error: an error would confirm
  // the row exists to somebody with no business knowing it does.
  const theirs = await bearer("Their Cursor", MEMBER);
  await markSpokeMcp(theirs);
  assert.equal(await as(OWNER, () => mcpTokenConnected(theirs)), false);
  assert.equal(await as(MEMBER, () => mcpTokenConnected(theirs)), true);
});
