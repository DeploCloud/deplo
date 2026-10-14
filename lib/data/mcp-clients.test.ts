import { test } from "node:test";
import assert from "node:assert/strict";

import { TEAM_A, TEAM_B, USER_1 } from "./identity-test-helpers";
import {
  countMcpAgents,
  getOAuthClientForConsent,
  listMyMcpAgents,
  listConnectableTeamIds,
  listMcpTeams,
  mintMcpConnection,
} from "./mcp-clients";
import { listTokens } from "./tokens/listing";
import { revokeToken } from "./tokens/revoke";
import { listActivity } from "./activity";
import {
  pg,
  OWNER,
  MEMBER,
  CLIENT,
  registerClientRow,
  consentRow,
  grantOwnerIn,
  as,
  setupMcpClientsDb,
} from "./mcp-clients-test-helpers";

setupMcpClientsDb();
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

// A crafted `/oauth/consent?client_id=` link used to mint a live token for a client the victim never heard of.
test("no approval on file mints nothing", async () => {
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

test("the teams ticked by default are exactly the ones the mint would accept", async () => {
  await grantOwnerIn(TEAM_B);
  assert.deepEqual(
    (await as(OWNER, listConnectableTeamIds)).sort(),
    [TEAM_A, TEAM_B].sort(),
  );

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

test("the consent screen names where THIS request returns, not the first address registered", async () => {
  await pg.query(
    `insert into oauth_client (id, client_id, name, redirect_uris, created_at)
     values ('oc_two', 'two', 'Trusted Tool', ARRAY['https://trusted.test/cb', 'https://attacker.test/cb'], now())`,
  );
  const shown = await as(OWNER, () =>
    getOAuthClientForConsent("two", "https://attacker.test/cb"),
  );
  assert.equal(shown?.redirectOrigin, "https://attacker.test");
  const none = await as(OWNER, () => getOAuthClientForConsent("two", null));
  assert.equal(none?.redirectOrigin, null, "no single address, no claim");
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

test("another person neither sees, counts nor revokes the connection", async () => {
  const { tokenId } = await as(OWNER, () =>
    mintMcpConnection({ clientId: CLIENT, capabilities: ["view"] }),
  );
  assert.deepEqual(await as(MEMBER, () => listTokens()), []);
  await assert.rejects(
    as(MEMBER, () => revokeToken(tokenId)),
    /not found/i,
  );
  assert.equal(await as(MEMBER, () => countMcpAgents()), 0);
  assert.deepEqual(await as(MEMBER, () => listMyMcpAgents()), []);
  assert.equal(await as(OWNER, () => countMcpAgents()), 1);
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
  await as(OWNER, () =>
    mintMcpConnection({ clientId: CLIENT, capabilities: ["view"] }),
  );
  const dump = JSON.stringify([
    await as(OWNER, () => listActivity()),
    await as(OWNER, () => listTokens()),
  ]);
  const fullSecret = /deplo_[A-Za-z0-9_-]{20,}/.exec(dump);
  assert.equal(fullSecret, null, `a raw bearer escaped: ${fullSecret?.[0]}`);
  assert.ok(!dump.includes("token_hash"), dump.slice(0, 200));
});

test("the consent path mints through createToken and never inserts a token itself", async () => {
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
  await as(OWNER, () =>
    mintMcpConnection({ clientId: CLIENT, capabilities: ["view"] }),
  );
  const tokens = await as(OWNER, () => listTokens());
  assert.equal(tokens.length, 1);
  assert.equal(tokens[0].oauthClientName, "Claude");
  assert.equal(tokens[0].mcp, true, "the robot mark did not reach the list");
});
