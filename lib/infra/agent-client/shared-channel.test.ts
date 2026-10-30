import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../../db/test-harness";
import { __setTestDb, __resetTestDb } from "../../db/client";
import { servers } from "../../db/schema/control-plane/servers";
import { seedServerRow, TRUNCATE_INFRA } from "../../data/infra-test-helpers";
import { certFingerprint, issueAgentServerCert } from "../../agent/pki";
import { AGENT_VERSION } from "../../version";
import {
  startAgentLinkListener,
  stopAgentLinkListener,
} from "../agent-link/listener";
import { LINK_CLOSE } from "../agent-link/protocol";
import { onAgentLink } from "../agent-link/registry";
import { connectAgent } from "./connect";
import { agentPreflight } from "./preflight";
import { dropAgentChannel } from "./channel-pool";
import { AgentOfflineError } from "./errors";
import {
  eventually,
  startFakeAgent,
  type FakeAgent,
  type FakeLink,
} from "./fake-agent-test-helpers";

// Every caller of a server shares its agent link's one channel (ADR-0040).
const SERVER = "srv_shared";

let db: TestDb;
let pg: PGlite;
let agent: FakeAgent;
let link: FakeLink;

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
  await pg.exec("truncate table rate_limits");
  agent = await startFakeAgent();
  await seedServerRow(db, {
    id: SERVER,
    ip: "127.0.0.1",
    host: "127.0.0.1",
    agent: {
      certFingerprint: agent.fingerprint,
      certPem: agent.certPem,
      version: AGENT_VERSION,
    },
  });
  const door = await startAgentLinkListener({ port: 0, host: "127.0.0.1" });
  const up = new Promise<void>((resolve) => {
    const off = onAgentLink((e) => {
      if (e.serverId === SERVER && e.type === "up") resolve(void off());
    });
  });
  link = await agent.link(door.port);
  await up;
});

afterEach(async () => {
  await stopAgentLinkListener();
  dropAgentChannel(SERVER);
  await agent.stop();
});

const stillOpen = () =>
  Promise.race([link.closed, new Promise((r) => setTimeout(r, 100, "open"))]);

async function helloOnce(): Promise<void> {
  const conn = await connectAgent(SERVER);
  try {
    assert.equal((await conn.hello()).agentVersion, AGENT_VERSION);
  } finally {
    conn.close();
  }
}

test("calls made at once to a server all ride its one link", async () => {
  await Promise.all(Array.from({ length: 6 }, helloOnce));
  assert.equal(await stillOpen(), "open");
  assert.equal(agent.connections().opened, 0, "nothing dialed the agent");
});

test("a caller closing its connection leaves the link to everyone else", async () => {
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

  await eventually(() => {
    agent.log("still here");
    return seen.includes("still here");
  });
  assert.equal((await watcher.hello()).agentVersion, AGENT_VERSION);
  await helloOnce();
  assert.equal(await stillOpen(), "open");
  logs.close();
  watcher.close();
});

test("the Hello pre-flight and the deploy after it share the link", async () => {
  assert.equal((await agentPreflight(SERVER)).agentVersion, AGENT_VERSION);
  await helloOnce();
  assert.equal(await stillOpen(), "open");
});

test("a new pin closes the link it no longer trusts, and the next call is refused", async () => {
  await helloOnce();
  const stranger = await issueAgentServerCert(["127.0.0.1"]);
  await db
    .update(servers)
    .set({ agentCertFingerprint: await certFingerprint(stranger.certPem) })
    .where(eq(servers.id, SERVER));

  const call = connectAgent(SERVER);
  assert.equal(await link.closed, LINK_CLOSE.revoked);
  await assert.rejects(call, AgentOfflineError);
});
