import { test, before, after, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../../db/test-harness";
import { __setTestDb, __resetTestDb } from "../../db/client";
import { servers } from "../../db/schema/control-plane/servers";
import { seedServerRow, TRUNCATE_INFRA } from "../../data/infra-test-helpers";
import { certFingerprint, issueAgentServerCert } from "../../agent/pki";
import { renewAgentCert } from "../../agent/cert-renewal";
import { runWithIdentity } from "../../auth/request-context";
import {
  seedIdentity,
  TEAM_A,
  TRUNCATE_IDENTITY,
  USER_1,
} from "../../data/identity-test-helpers";
import { removeServer } from "../../data/servers/removal";
import { AGENT_TOO_OLD_MESSAGE, AGENT_VERSION } from "../../version";
import { connectAgent, openAgent } from "./connect";
import { agentPreflight } from "./preflight";
import { dropAgentChannel } from "./channel-pool";
import { AgentTooOldError, AgentUnreachableError } from "./errors";
import {
  eventually,
  startFakeAgent,
  type FakeAgent,
} from "./fake-agent-test-helpers";

const SERVER = "srv_shared";

let db: TestDb;
let pg: PGlite;
let agent: FakeAgent;

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
});

after(async () => {
  __resetTestDb();
  await pg.close();
});

beforeEach(async () => {
  await pg.exec(TRUNCATE_INFRA);
  agent = await startFakeAgent();
  await seedServerRow(db, {
    id: SERVER,
    ip: "127.0.0.1",
    host: "127.0.0.1",
    agent: {
      port: agent.port,
      certFingerprint: agent.fingerprint,
      certPem: agent.certPem,
      version: AGENT_VERSION,
    },
  });
});

afterEach(async () => {
  dropAgentChannel(SERVER);
  await agent.stop();
});

async function helloOnce(): Promise<void> {
  const conn = await connectAgent(SERVER);
  try {
    assert.equal((await conn.hello()).agentVersion, AGENT_VERSION);
  } finally {
    conn.close();
  }
}

test("calls one after another to a server ride one connection", async () => {
  await helloOnce();
  await helloOnce();
  await helloOnce();
  assert.equal(agent.connections().opened, 1);
});

test("calls made at once to a server ride one connection", async () => {
  await Promise.all(Array.from({ length: 6 }, helloOnce));
  assert.equal(agent.connections().opened, 1);
});

test("a caller closing its connection leaves the channel to everyone else", async () => {
  const watcher = await connectAgent(SERVER);
  await watcher.hello(); // the gate's answer; every hello after it is live
  const seen: string[] = [];
  const logs = watcher.followLogs("app_1", "web", 0);
  logs.onData((chunk) => seen.push(chunk.toString()));

  const quick = await connectAgent(SERVER);
  await quick.hello();
  quick.close();
  const other = await connectAgent(SERVER);
  other.followLogs("app_1", "web", 0).close();
  other.close();

  agent.log("still here");
  await eventually(() => seen.includes("still here"));
  assert.equal((await watcher.hello()).agentVersion, AGENT_VERSION);
  await helloOnce();
  assert.deepEqual(agent.connections(), { opened: 1, open: 1 });
  logs.close();
  watcher.close();
});

const repin = (fingerprint: string) =>
  db
    .update(servers)
    .set({ agentCertFingerprint: fingerprint })
    .where(eq(servers.id, SERVER));

test("a new pin takes effect on the next call, even with a connection open", async () => {
  await helloOnce();
  const stranger = await issueAgentServerCert(["127.0.0.1"]);
  await repin(await certFingerprint(stranger.certPem));
  await assert.rejects(connectAgent(SERVER), (e) => {
    assert.ok(e instanceof AgentUnreachableError);
    assert.equal(e.trust, true);
    return true;
  });

  await repin(agent.fingerprint);
  await helloOnce();
  assert.equal(agent.connections().open, 1, "the old connections are gone");
});

test("a new address takes effect on the next call, even with a connection open", async () => {
  await helloOnce();
  const nobody = net.createServer();
  await new Promise<void>((r) => nobody.listen(0, "127.0.0.1", r));
  const { port } = nobody.address() as net.AddressInfo;
  await new Promise((r) => nobody.close(r));
  await db
    .update(servers)
    .set({ agentPort: port })
    .where(eq(servers.id, SERVER));

  await assert.rejects(connectAgent(SERVER), AgentUnreachableError);
});

test("a renewed certificate drops the channel, and the next call rides a new one", async () => {
  const before = agent.fingerprint;
  await renewAgentCert(SERVER, ["127.0.0.1"]);
  assert.notEqual(agent.fingerprint, before);
  await eventually(() => agent.connections().open === 0);

  await helloOnce();
  assert.deepEqual(agent.connections(), { opened: 2, open: 1 });
});

test("removing a server drops its channel and refuses every call after", async () => {
  process.env.DEPLO_PUBLIC_URL = "https://deplo.test";
  await pg.exec(TRUNCATE_IDENTITY);
  await seedIdentity(db, {
    users: [{ id: USER_1, teamId: TEAM_A, role: "owner" }],
  });
  await helloOnce();

  await runWithIdentity({ userId: USER_1, teamId: TEAM_A }, () =>
    removeServer(SERVER),
  );
  await eventually(() => agent.connections().open === 0);
  await assert.rejects(connectAgent(SERVER), AgentUnreachableError);
});

test("a channel never outlives a day, so never its client certificate", async (t) => {
  const now = Date.now();
  mock.timers.enable({ apis: ["Date"], now: now - 25 * 3_600_000 });
  t.after(() => mock.timers.reset());
  await helloOnce();

  mock.timers.setTime(now);
  await helloOnce();
  assert.deepEqual(agent.connections(), { opened: 2, open: 1 });
});

test("an agent back from an outage answers the very next call", async () => {
  const deploy = await connectAgent(SERVER);
  agent.refuse(true);
  await assert.rejects(deploy.inspect("web"), AgentUnreachableError);
  await assert.rejects(deploy.inspect("web"), AgentUnreachableError);
  deploy.close();

  agent.refuse(false);
  const probe = await openAgent(SERVER);
  assert.equal((await probe.hello()).agentVersion, AGENT_VERSION);
  probe.close();
  await helloOnce();
});

test("a connection that went stale while idle never costs a call", async () => {
  await helloOnce();
  agent.goStale();
  await helloOnce();
  assert.deepEqual(agent.connections(), { opened: 2, open: 1 });
});

test("the Hello pre-flight and the deploy after it share one connection", async () => {
  assert.equal((await agentPreflight(SERVER)).agentVersion, AGENT_VERSION);
  await helloOnce();
  assert.equal(agent.connections().opened, 1);
});

test("an agent below the minimum is still refused, and still reachable past the gate", async (t) => {
  const old = await startFakeAgent({ version: "0.1.0" });
  t.after(async () => {
    dropAgentChannel("srv_old");
    await old.stop();
  });
  await seedServerRow(db, {
    id: "srv_old",
    ip: "127.0.0.1",
    host: "127.0.0.1",
    agent: {
      port: old.port,
      certFingerprint: old.fingerprint,
      certPem: old.certPem,
      version: AGENT_VERSION,
    },
  });

  await assert.rejects(connectAgent("srv_old"), (e) => {
    assert.ok(e instanceof AgentTooOldError);
    assert.equal(e.message, AGENT_TOO_OLD_MESSAGE);
    return true;
  });
  const conn = await openAgent("srv_old");
  assert.equal((await conn.hello()).agentVersion, "0.1.0");
  conn.close();
  assert.equal(old.connections().opened, 1);
});
