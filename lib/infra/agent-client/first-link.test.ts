import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";

import { makeTestDb, type TestDb } from "../../db/test-harness";
import { __setTestDb, __resetTestDb } from "../../db/client";
import { seedServerRow, TRUNCATE_INFRA } from "../../data/infra-test-helpers";
import type { DeployRequest } from "../../agent/gen/agent";
import { AGENT_VERSION } from "../../version";
import { unreachableMessage } from "../server-health";
import {
  startAgentLinkListener,
  stopAgentLinkListener,
} from "../agent-link/listener";
import { getServerById } from "../../data/servers/roster";
import { LINK_CLOSE } from "../agent-link/protocol";
import { doorClosed, doorOpened, onAgentLink } from "../agent-link/registry";
import { dropAgentChannel } from "./channel-pool";
import {
  __setAgentConnectorForTest,
  connectAgent,
  connectAgentAt,
  openAgent,
} from "./connect";
import type { AgentConnection } from "./connection";
import { AgentNotLinkedError, AgentUnreachableError } from "./errors";
import { startFakeAgent, type FakeAgent } from "./fake-agent-test-helpers";

// A server's first link decides how Deplo may reach it (ADR-0041): real agents, real certificates.
const SERVER = "srv_first_link";

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
  door = (await startAgentLinkListener({ port: 0, host: "127.0.0.1" })).port;
});

afterEach(async () => {
  await stopAgentLinkListener();
  dropAgentChannel(SERVER);
  await agent.stop();
});

async function linkIn(): Promise<void> {
  const up = new Promise<void>((resolve) => {
    const off = onAgentLink((e) => {
      if (e.serverId === SERVER && e.type === "up") resolve(void off());
    });
  });
  assert.equal((await agent.link(door)).status, 101);
  await up;
}

/** Deplo stops and starts again: every link ends, and nothing in memory remembers them. */
async function restart(): Promise<void> {
  await stopAgentLinkListener();
  door = (await startAgentLinkListener({ port: 0, host: "127.0.0.1" })).port;
}

async function helloVia(open: typeof connectAgent): Promise<string> {
  const conn = await open(SERVER);
  try {
    return (await conn.hello()).agentVersion;
  } finally {
    conn.close();
  }
}

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

test("once a server has linked, Deplo never dials it again, even right after a restart", async () => {
  await linkIn();
  await restart();

  // Its server agent still listens: only the remembered link keeps Deplo off its port.
  const calls = Promise.all([helloVia(connectAgent), helloVia(openAgent)]);
  await new Promise((r) => setTimeout(r, 300));
  await linkIn();
  assert.deepEqual(await calls, [AGENT_VERSION, AGENT_VERSION]);
  assert.equal(agent.connections().opened, 0, "nothing dialed it");
  await assert.rejects(
    connectAgentAt(SERVER, { agentPort: agent.port }),
    AgentUnreachableError,
  );
});

test("the door stores a server's first link as it admits it, before anyone hears it come up", async () => {
  // A door that admits nothing more verifies the link, then turns it away.
  doorClosed();
  const refused = await agent.link(door);
  assert.equal(await refused.closed, LINK_CLOSE.revoked);
  assert.equal((await getServerById(SERVER))?.firstLinkedAt, undefined);

  doorOpened();
  const seen = new Promise<string | undefined>((resolve) => {
    const off = onAgentLink((e) => {
      if (e.serverId !== SERVER || e.type !== "up") return;
      off();
      resolve(getServerById(SERVER).then((s) => s?.firstLinkedAt));
    });
  });
  assert.equal((await agent.link(door)).status, 101);
  assert.ok(await seen, "stored before the link was announced");
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
