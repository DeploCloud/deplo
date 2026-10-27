import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { graphql, type GraphQLObjectType } from "graphql";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { runWithIdentity } from "../auth/request-context";
import { getCurrentUser } from "../auth/current-user";
import { getActiveTeamId, reachableCapabilities } from "../membership";
import { schema } from "../graphql/schema";
import type { GraphQLContext } from "../graphql/context";
import { seedIdentity, TEAM_A, USER_1 } from "./identity-test-helpers";
import { TRUNCATE_INFRA, seedServerRow } from "./infra-test-helpers";
import { listActivity } from "./activity";
import { updateServerAddress } from "./servers/agent-maintenance";
import { getServerById } from "./servers/roster";
import { dropAgentChannel } from "../infra/agent-client/channel-pool";
import {
  startFakeAgent,
  type FakeAgent,
  type FakeLink,
} from "../infra/agent-client/fake-agent-test-helpers";
import {
  startAgentLinkListener,
  stopAgentLinkListener,
} from "../infra/agent-link/listener";
import { onAgentLink } from "../infra/agent-link/registry";
import { AGENT_VERSION } from "../version";

const SERVER = "srv_linked";

let db: TestDb;
let pg: PGlite;
let agent: FakeAgent;
let door: number;

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
});

after(async () => {
  __resetTestDb();
  await pg.close();
});

beforeEach(async () => {
  await pg.exec(`${TRUNCATE_INFRA}
    truncate table users, teams restart identity cascade;`);
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner", isInstanceAdmin: true },
    ],
  });
  agent = await startFakeAgent();
  await seedServerRow(db, {
    id: SERVER,
    name: "linked",
    ip: "127.0.0.1",
    host: "127.0.0.1",
    status: "online",
    agent: {
      port: agent.port,
      certFingerprint: agent.fingerprint,
      certPem: agent.certPem,
      version: AGENT_VERSION,
    },
  });
  door = (await startAgentLinkListener({ port: 0, host: "127.0.0.1" })).port;
});

afterEach(async () => {
  await stopAgentLinkListener();
  dropAgentChannel(SERVER);
  await agent.stop();
});

const asAdmin = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);

function linkEvent(type: "up" | "down"): Promise<void> {
  return new Promise((resolve) => {
    const off = onAgentLink((e) => {
      if (e.serverId !== SERVER || e.type !== type) return;
      off();
      resolve();
    });
  });
}

async function linkIn(): Promise<FakeLink> {
  const up = linkEvent("up");
  const link = await agent.link(door);
  assert.equal(link.status, 101);
  await up;
  return link;
}

function agentPortField(): Promise<unknown> {
  return asAdmin(async () => {
    const res = await graphql({
      schema,
      source: `{ server(id: "${SERVER}") { agentPort } }`,
      contextValue: {
        viewer: await getCurrentUser(),
        teamId: await getActiveTeamId(),
        capabilities: await reachableCapabilities(),
        via: "cookie",
        identity: null,
      } satisfies GraphQLContext,
    });
    assert.equal(res.errors, undefined);
    return (res.data?.server as { agentPort: unknown }).agentPort;
  });
}

// "localhost" reaches the fake agent's own port, so any dial there would be counted.
test("a linked server's new address is saved without Deplo connecting to it", async () => {
  await linkIn();
  const dialed = agent.connections().opened;
  const { warning } = await asAdmin(() =>
    updateServerAddress({ id: SERVER, address: "localhost" }),
  );
  assert.equal(warning, null);
  assert.equal(agent.connections().opened, dialed, "nothing dialed it");
  const server = await asAdmin(() => getServerById(SERVER));
  assert.equal(server?.ip, "localhost");
  assert.equal(server?.host, "localhost");
});

test("a linked server that is offline right now is saved all the same, at once", async () => {
  const link = await linkIn();
  const down = linkEvent("down");
  link.drop();
  await down;
  agent.refuse(true);
  const dialed = agent.connections().opened;
  const started = Date.now();
  await asAdmin(() =>
    updateServerAddress({ id: SERVER, address: "localhost" }),
  );
  assert.ok(Date.now() - started < 2_000, "it did not wait for the link");
  assert.equal(agent.connections().opened, dialed, "nothing dialed it");
  assert.equal((await asAdmin(() => getServerById(SERVER)))?.ip, "localhost");
});

test("moments after Deplo starts, a server on its way back is saved once it links, never dialed", async () => {
  agent.refuse(true);
  const dialed = agent.connections().opened;
  const saving = asAdmin(() =>
    updateServerAddress({ id: SERVER, address: "localhost" }),
  );
  await new Promise((r) => setTimeout(r, 200));
  await linkIn();
  assert.deepEqual(await saving, { warning: null });
  assert.equal(agent.connections().opened, dialed, "nothing dialed it");
  assert.equal((await asAdmin(() => getServerById(SERVER)))?.ip, "localhost");
});

test("the API gives a server that links in no agent port, and names no link of its own", async () => {
  assert.equal(await agentPortField(), agent.port);
  await linkIn();
  assert.equal(await agentPortField(), null);
  const fields = (schema.getType("Server") as GraphQLObjectType).getFields();
  assert.ok(
    !("linked" in fields),
    "how a server is reached stays out of the API",
  );
});

test("after Deplo restarts, a server that linked once still shows no agent port, and its address is saved without a dial", async () => {
  await linkIn();
  await stopAgentLinkListener();
  door = (await startAgentLinkListener({ port: 0, host: "127.0.0.1" })).port;

  assert.equal(await agentPortField(), null);
  const started = Date.now();
  const { warning } = await asAdmin(() =>
    updateServerAddress({ id: SERVER, address: "localhost" }),
  );
  assert.equal(warning, null);
  assert.ok(Date.now() - started < 2_000, "it did not wait for the link");
  assert.equal(agent.connections().opened, 0, "nothing dialed it");
  assert.equal((await asAdmin(() => getServerById(SERVER)))?.ip, "localhost");
});

test("a linked server's agent port is left alone, and Activity names the address only", async () => {
  await linkIn();
  await asAdmin(() =>
    updateServerAddress({ id: SERVER, address: "localhost", agentPort: 4242 }),
  );
  const server = await asAdmin(() => getServerById(SERVER));
  assert.equal(server?.agent?.port, agent.port);
  const [entry] = await asAdmin(() => listActivity(1, { types: ["server"] }));
  assert.equal(entry?.message, "Changed server linked address to localhost");
});
