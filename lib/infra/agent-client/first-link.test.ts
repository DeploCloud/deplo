import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";

import { makeTestDb, type TestDb } from "../../db/test-harness";
import { __setTestDb, __resetTestDb } from "../../db/client";
import { seedServerRow, TRUNCATE_INFRA } from "../../data/infra-test-helpers";
import type { DeployRequest } from "../../agent/gen/agent";
import { AGENT_VERSION } from "../../version";
import { unreachableMessage } from "../server-health";
import { dropAgentChannel } from "./channel-pool";
import {
  __setAgentConnectorForTest,
  connectAgent,
  connectAgentAt,
  openAgent,
} from "./connect";
import type { AgentConnection } from "./connection";
import { AgentNotLinkedError } from "./errors";
import { startFakeAgent, type FakeAgent } from "./fake-agent-test-helpers";

// A server's first link decides how Deplo may reach it (ADR-0041): real agents, real certificates.
const SERVER = "srv_first_link";

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

/** What the user reads: plain words, never a port, a link or a shell, and never a bare "agent". */
function refused(e: unknown): boolean {
  assert.ok(e instanceof AgentNotLinkedError, String(e));
  const shown = unreachableMessage(e) ?? "";
  assert.match(shown, /can't connect to Deplo/);
  assert.doesNotMatch(shown, /port|link|shell|ssh|command/i);
  assert.doesNotMatch(shown.replace(/server agent/g, ""), /agent/i);
  return true;
}

test("over its dial, a server that never linked takes only the calls that bring it onto its link", async () => {
  const conn = await connectAgent(SERVER);
  try {
    assert.equal((await conn.hello()).agentVersion, AGENT_VERSION);
    const pair = { primary: "https://panel.example.com", fallback: "" };
    assert.deepEqual(await conn.setLinkAddresses(pair), pair);
    assert.ok((await conn.renewalCsr()).csrPem);

    await assert.rejects(conn.inspect("web"), refused);
    await assert.rejects(conn.deploy({} as DeployRequest).next(), refused);
    assert.throws(() => conn.followLogs("app_1", "web", 0), refused);
    assert.throws(() => conn.attach("app_1", "web", true, 80, 24), refused);
  } finally {
    conn.close();
  }
  assert.equal(agent.connections().opened, 1);
});

test("past the minimum-agent gate, the dial still carries only what brings the server over", async () => {
  const conn = await openAgent(SERVER);
  try {
    assert.equal((await conn.hello()).agentVersion, AGENT_VERSION);
    // The fake updates nothing: an answer from it, not a refusal, is what reaching it looks like.
    const reached = (e: unknown) => !(e instanceof AgentNotLinkedError);
    await assert.rejects(conn.selfUpdate(AGENT_VERSION, {}), reached);
    await assert.rejects(
      conn.updateControlPlane({ controlPlaneHint: "", version: "1.0.0" }),
      reached,
    );
    await assert.rejects(conn.metrics(), refused);
    await assert.rejects(conn.selfUninstall(), refused);
    await assert.rejects(
      conn.hostInfo({ dataDir: "", controlPlaneHint: "" }),
      refused,
    );
  } finally {
    conn.close();
  }
});

test("an override address dials a server that never linked for what brings it over, and nothing else", async () => {
  const conn = await connectAgentAt(SERVER, { agentPort: agent.port });
  try {
    assert.equal((await conn.hello()).agentVersion, AGENT_VERSION);
    await assert.rejects(conn.inspect("web"), refused);
  } finally {
    conn.close();
  }
});

test("a stubbed connection is the stub's own, whether or not its server ever linked", async (t) => {
  t.after(() => __setAgentConnectorForTest());
  const stub = {
    inspect: async () => ({ exists: true, running: true, state: "running" }),
    close() {},
  } as unknown as AgentConnection;
  __setAgentConnectorForTest(async (id) => (id === SERVER ? stub : null));

  assert.equal(await connectAgent(SERVER), stub);
  assert.equal(await openAgent(SERVER), stub);
  assert.equal((await stub.inspect("web")).running, true);
  assert.equal(agent.connections().opened, 0);
});
