import { test } from "node:test";
import assert from "node:assert/strict";

import {
  countMcpAgents,
  listMyMcpAgents,
  mcpTokenConnected,
  mintMcpConnection,
} from "./mcp-clients";
import { listTokens } from "./tokens/listing";
import { createToken } from "./tokens/mint";
import { stampMcpUse } from "./tokens/authenticate";
import {
  pg,
  OWNER,
  MEMBER,
  CLIENT,
  registerClientRow,
  consentRow,
  as,
  setupMcpClientsDb,
} from "./mcp-clients-test-helpers";

setupMcpClientsDb();
async function bearer(name: string, userId = OWNER) {
  const { token } = await as(userId, () =>
    createToken({ name, capabilities: ["view", "deploy_apps"] }),
  );
  return token.id;
}

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

test("your connected agents list names each one and how it connected", async () => {
  const id = await bearer("Claude Code");
  await markSpokeMcp(id);
  await as(OWNER, () =>
    mintMcpConnection({ clientId: CLIENT, capabilities: ["view"] }),
  );
  const agents = await as(OWNER, () => listMyMcpAgents());
  assert.deepEqual(
    agents
      .map((a) => [a.name, a.viaSignIn])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    [
      ["Claude", true],
      ["Claude Code", false],
    ],
  );
  assert.ok(agents.find((a) => a.id === id)?.lastUsedAt);
});

test("each agent keeps the mark it connected with", async () => {
  const { token } = await as(OWNER, () =>
    createToken({
      name: "My laptop",
      capabilities: ["view"],
      mcpAgent: "claude-code",
    }),
  );
  await markSpokeMcp(token.id);
  await registerClientRow(
    "client_claude",
    "Claude",
    "https://claude.ai/api/mcp/auth_callback",
  );
  await consentRow("client_claude", OWNER);
  await as(OWNER, () =>
    mintMcpConnection({ clientId: "client_claude", capabilities: ["view"] }),
  );
  const agents = await as(OWNER, () => listMyMcpAgents());
  assert.deepEqual(
    agents
      .map((a) => [a.name, a.agent])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    [
      ["Claude", "claude-web"],
      ["My laptop", "claude-code"],
    ],
  );
  await assert.rejects(
    as(OWNER, () => createToken({ name: "Robot", mcpAgent: "skynet" })),
    /not an agent/,
  );
});

test("a client's own name fills a blank agent, never a recorded one", async () => {
  const blank = await bearer("Blank");
  const { token } = await as(OWNER, () =>
    createToken({ name: "Set", capabilities: ["view"], mcpAgent: "cursor" }),
  );
  await stampMcpUse(blank, "claude-code");
  await stampMcpUse(token.id, "claude-code");
  const agents = await as(OWNER, () => listMyMcpAgents());
  assert.deepEqual(
    agents
      .map((a) => [a.name, a.agent])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    [
      ["Blank", "claude-code"],
      ["Set", "cursor"],
    ],
  );
});

test("a token that has never spoken MCP is not an agent", async () => {
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

test("both kinds count, each person only their own", async () => {
  const id = await bearer("Cursor", MEMBER);
  await markSpokeMcp(id);
  await as(OWNER, () =>
    mintMcpConnection({ clientId: CLIENT, capabilities: ["view"] }),
  );
  assert.equal(await as(OWNER, () => countMcpAgents()), 1);
  assert.equal(await as(MEMBER, () => countMcpAgents()), 1);
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

  const theirs = await bearer("Their Cursor", MEMBER);
  await markSpokeMcp(theirs);
  assert.equal(await as(OWNER, () => mcpTokenConnected(theirs)), false);
  assert.equal(await as(MEMBER, () => mcpTokenConnected(theirs)), true);
});

test("an agent's token waits for the team's MCP switch", async () => {
  await pg.query(`update teams set mcp_enabled = false`);
  await assert.rejects(
    as(OWNER, () =>
      createToken({
        name: "Early",
        capabilities: ["view"],
        mcpAgent: "cursor",
      }),
    ),
    /Turn on MCP/,
  );
  const plain = await as(OWNER, () =>
    createToken({ name: "Plain", capabilities: ["view"] }),
  );
  assert.ok(plain.raw.startsWith("deplo_"), "a plain API token is not gated");
});
