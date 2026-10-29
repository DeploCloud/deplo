import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";

import { makeTestDb, type TestDb } from "../../db/test-harness";
import { __setTestDb, __resetTestDb } from "../../db/client";
import { seedServerRow, TRUNCATE_INFRA } from "../../data/infra-test-helpers";
import type { Server } from "../../types/server";
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
import { __setAgentConnectorForTest, connectAgent, openAgent } from "./connect";
import type { AgentConnection } from "./connection";
import {
  AgentNeedsReinstallError,
  AgentOfflineError,
  AgentUnreachableError,
} from "./errors";
import {
  eventually,
  startFakeAgent,
  type FakeAgent,
} from "./fake-agent-test-helpers";

// Every call to a server rides its agent link, and nothing dials it (ADR-0040): real agents, real certificates.
const SERVER = "srv_link_only";

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

async function seed(over: Partial<Server> = {}): Promise<void> {
  await seedServerRow(db, {
    id: SERVER,
    ip: "127.0.0.1",
    host: "127.0.0.1",
    agent: {
      certFingerprint: agent.fingerprint,
      certPem: agent.certPem,
      version: AGENT_VERSION,
    },
    ...over,
  });
}

beforeEach(async () => {
  await pg.exec(TRUNCATE_INFRA);
  // It still listens, as a server agent installed before the link does until it is told to stop.
  agent = await startFakeAgent();
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

test("a call to a server that has not linked yet waits for its link and rides it, never dialing", async () => {
  await seed();
  const calls = Promise.all([helloVia(connectAgent), helloVia(openAgent)]);
  await new Promise((r) => setTimeout(r, 300));
  await linkIn();
  assert.deepEqual(await calls, [AGENT_VERSION, AGENT_VERSION]);
  assert.equal(agent.connections().opened, 0, "nothing dialed it");
});

test("a server whose link never comes is offline after the wait, and still never dialed", async () => {
  await seed();
  const started = performance.now();
  const offline = (e: unknown) => {
    assert.ok(e instanceof AgentOfflineError, String(e));
    return true;
  };
  await Promise.all([
    assert.rejects(connectAgent(SERVER), offline),
    assert.rejects(openAgent(SERVER), offline),
  ]);
  const waited = performance.now() - started;
  assert.ok(waited > 9_500 && waited < 12_000, `waited ${waited} ms`);
  assert.equal(agent.connections().opened, 0, "nothing dialed it");
});

test("over its link, a server takes every call, not only the ones that bring it over", async () => {
  await seed();
  await linkIn();
  const conn = await connectAgent(SERVER);
  try {
    const logs = conn.followLogs("app_1", "web", 0);
    const seen: string[] = [];
    logs.onData((chunk) => seen.push(chunk.toString()));
    await eventually(() => {
      agent.log("streaming");
      return seen.length > 0;
    });
    logs.close();
    // The fake implements no inspect: what comes back is the server agent's own answer.
    await assert.rejects(
      conn.inspect("web"),
      (e) => !(e instanceof AgentUnreachableError),
    );
  } finally {
    conn.close();
  }
  assert.equal(agent.connections().opened, 0);
});

test("once a server has linked, Deplo waits for it after a restart and never dials it", async () => {
  await seed();
  await linkIn();
  await restart();

  const calls = Promise.all([helloVia(connectAgent), helloVia(openAgent)]);
  await new Promise((r) => setTimeout(r, 300));
  await linkIn();
  assert.deepEqual(await calls, [AGENT_VERSION, AGENT_VERSION]);
  assert.equal(agent.connections().opened, 0, "nothing dialed it");
});

/** What the user reads: plain words that point to the reinstall, never a port, a link or a shell. */
function needsReinstall(e: unknown): boolean {
  assert.ok(e instanceof AgentNeedsReinstallError, String(e));
  const shown = unreachableMessage(e) ?? "";
  assert.match(shown, /server agent is reinstalled/);
  assert.match(shown, /Advanced/);
  assert.doesNotMatch(shown, /port|link|shell|ssh|command|firewall/i);
  assert.doesNotMatch(shown.replace(/server agent/g, ""), /agent/i);
  return true;
}

test("a server left behind at the update stop is refused at once, with what brings it back", async () => {
  await seed({ leftBehindAt: "2026-10-28T00:00:00.000Z" });
  const started = performance.now();
  await assert.rejects(connectAgent(SERVER), needsReinstall);
  await assert.rejects(openAgent(SERVER), needsReinstall);
  assert.ok(performance.now() - started < 2_000, "no wait for a link");
  assert.equal(agent.connections().opened, 0);
});

test("a server whose server agent is too old to link is refused the same way", async () => {
  await seed({
    agent: {
      certFingerprint: agent.fingerprint,
      certPem: agent.certPem,
      version: "0.4.0",
    },
  });
  await assert.rejects(connectAgent(SERVER), needsReinstall);
  await assert.rejects(openAgent(SERVER), needsReinstall);
  assert.equal(agent.connections().opened, 0);
});

test("a server left behind that connects after all is used like any other, its apps and settings kept", async () => {
  await seed({ leftBehindAt: "2026-10-28T00:00:00.000Z" });
  await linkIn();
  assert.equal(await helloVia(connectAgent), AGENT_VERSION);
  const server = await getServerById(SERVER);
  assert.ok(server?.firstLinkedAt);
  assert.equal(server?.leftBehindAt, "2026-10-28T00:00:00.000Z");
});

test("the door stores a server's first link as it admits it, before anyone hears it come up", async () => {
  await seed();
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

test("a stubbed connection is the stub's own, whether or not its server could link", async (t) => {
  await seed({ leftBehindAt: "2026-10-28T00:00:00.000Z" });
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
