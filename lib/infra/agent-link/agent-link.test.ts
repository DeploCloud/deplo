import { test, before, after, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import net from "node:net";

import type { PGlite } from "@electric-sql/pglite";
import * as x509 from "@peculiar/x509";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../../db/test-harness";
import { __setTestDb, __resetTestDb } from "../../db/client";
import { servers } from "../../db/schema/control-plane/servers";
import { seedServerRow, TRUNCATE_INFRA } from "../../data/infra-test-helpers";
import {
  seedIdentity,
  TEAM_A,
  TRUNCATE_IDENTITY,
  USER_1,
} from "../../data/identity-test-helpers";
import { completeBootstrap } from "../../data/servers/agent-handshake";
import { removeServer } from "../../data/servers/removal";
import { runWithIdentity } from "../../auth/request-context";
import type { HelloResponse } from "../../agent/gen/agent";
import { mintBootstrap } from "../../agent/bootstrap";
import { renewAgentCert } from "../../agent/cert-renewal";
import { certFingerprint, issueAgentServerCert } from "../../agent/pki";
import { AGENT_VERSION } from "../../version";
import { connectAgent, openAgent } from "../agent-client/connect";
import { dropAgentChannel } from "../agent-client/channel-pool";
import {
  AgentTooOldError,
  AgentUnreachableError,
} from "../agent-client/errors";
import {
  eventually,
  knock,
  startFakeAgent,
  type FakeAgent,
  type FakeLink,
} from "../agent-client/fake-agent-test-helpers";
import { HEALTH_MESSAGES, unreachableMessage } from "../server-health";
import { startAgentLinkListener, stopAgentLinkListener } from "./listener";
import { LINK_CLOSE, LINK_RATE_LIMIT, LINK_SETTLE_MS } from "./protocol";
import { onAgentLink } from "./registry";

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
  await pg.exec(TRUNCATE_INFRA);
  await pg.exec("truncate table rate_limits");
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

function linkUp(serverId = SERVER): Promise<HelloResponse> {
  return new Promise((resolve) => {
    const off = onAgentLink((e) => {
      if (e.serverId !== serverId || e.type !== "up") return;
      off();
      resolve(e.hello);
    });
  });
}

async function makeCsr(): Promise<string> {
  const keys = (await webcrypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as unknown as CryptoKeyPair;
  const csr = await x509.Pkcs10CertificateRequestGenerator.create({
    name: "CN=deplo-agent",
    keys,
    signingAlgorithm: { name: "Ed25519" },
  });
  return csr.toString("pem");
}

function linkDown(serverId = SERVER): Promise<string> {
  return new Promise((resolve) => {
    const off = onAgentLink((e) => {
      if (e.serverId !== serverId || e.type !== "down") return;
      off();
      resolve(e.reason);
    });
  });
}

async function helloOver(serverId = SERVER): Promise<string> {
  const conn = await connectAgent(serverId);
  try {
    return (await conn.hello()).agentVersion;
  } finally {
    conn.close();
  }
}

test("a linked agent below the minimum is refused at the gate, and still reachable past it", async (t) => {
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
  const up = linkUp("srv_old");
  await old.link(door);
  await up;

  await assert.rejects(connectAgent("srv_old"), AgentTooOldError);
  const conn = await openAgent("srv_old");
  assert.equal((await conn.hello()).agentVersion, "0.1.0");
  conn.close();
  assert.equal(old.connections().opened, 0, "it never dialed the agent");
});

test("the door turns away what it cannot trust before any handshake", async () => {
  const stranger = await issueAgentServerCert(["127.0.0.1"]);
  const unknown = await certFingerprint(stranger.certPem);
  assert.equal((await knock(door, { claim: unknown })).status, 404);
  assert.equal((await knock(door, { claim: "not-a-fingerprint" })).status, 400);
  assert.equal((await knock(door, { claim: null })).status, 400);
  const claim = agent.fingerprint;
  assert.equal((await knock(door, { claim, protocol: null })).status, 400);
  assert.equal((await knock(door, { claim, protocol: "v0" })).status, 400);
  assert.equal((await knock(door, { claim, path: "/api/x" })).status, 404);

  await db
    .update(servers)
    .set({ agentPort: null })
    .where(eq(servers.id, SERVER));
  assert.equal((await agent.link(door)).status, 404, "never called home");
  await db
    .update(servers)
    .set({ agentPort: agent.port, agentCertFingerprint: "" })
    .where(eq(servers.id, SERVER));
  assert.equal((await agent.link(door)).status, 404, "pin withdrawn");
});

test("the door slows down one address that keeps knocking, and only that one", async () => {
  const claim = "0".repeat(64);
  const from = "203.0.113.7";
  for (let i = 0; i < LINK_RATE_LIMIT.limit; i++)
    assert.equal(
      (await knock(door, { claim, forwardedFor: from })).status,
      404,
    );

  const limited = await knock(door, { claim, forwardedFor: from });
  assert.equal(limited.status, 429);
  const wait = Number(limited.retryAfter);
  assert.ok(wait > 0 && wait <= 60, `Retry-After ${limited.retryAfter}`);
  const known = await agent.link(door);
  assert.equal(known.status, 101, "another address is not slowed down");
  assert.equal(
    (await knock(door, { claim: agent.fingerprint, forwardedFor: from }))
      .status,
    429,
  );
});

test("a call to a server whose agent links in rides the link", async () => {
  const up = linkUp();
  assert.equal((await agent.link(door)).status, 101);
  assert.equal((await up).agentVersion, AGENT_VERSION);

  assert.equal(await helloOver(), AGENT_VERSION);
  assert.equal(agent.connections().opened, 0, "nothing dialed the agent");
});

test("the newest verified link for a server replaces the older one", async () => {
  let up = linkUp();
  const first = await agent.link(door);
  await up;
  assert.equal(await helloOver(), AGENT_VERSION);

  up = linkUp();
  const second = await agent.link(door);
  await up;
  assert.equal(await first.closed, LINK_CLOSE.replaced);
  assert.equal(await stillOpen(second), "open");
  assert.equal(await helloOver(), AGENT_VERSION);
});

test("a call waits for a link that is momentarily missing", async () => {
  let up = linkUp();
  const first = await agent.link(door);
  await up;
  const down = linkDown();
  first.drop();
  await down;

  const call = helloOver();
  await new Promise((r) => setTimeout(r, 300));
  up = linkUp();
  await agent.link(door);
  await up;
  assert.equal(await call, AGENT_VERSION);
  assert.equal(agent.connections().opened, 0, "it never dialed the agent");
});

test("a call fails as offline when the link stays away for about 10 s", async () => {
  const up = linkUp();
  const link = await agent.link(door);
  await up;
  const down = linkDown();
  link.drop();
  await down;

  const started = performance.now();
  await assert.rejects(connectAgent(SERVER), (e) => {
    assert.ok(e instanceof AgentUnreachableError);
    assert.equal(
      unreachableMessage(e),
      `This server is offline. ${HEALTH_MESSAGES.linkDown}`,
    );
    return true;
  });
  const waited = performance.now() - started;
  assert.ok(waited > 9_500 && waited < 12_000, `waited ${waited} ms`);
  assert.equal(agent.connections().opened, 0, "it never dialed the agent");
});

async function followLogs() {
  const conn = await connectAgent(SERVER);
  const logs = conn.followLogs("app_1", "web", 0);
  const seen: string[] = [];
  logs.onData((chunk) => seen.push(chunk.toString()));
  const ended = new Promise<string | undefined>((r) => logs.onExit(r));
  // Until the stream has reached the agent, a line goes nowhere.
  await eventually(() => {
    agent.log("streaming");
    return seen.length > 0;
  });
  return {
    ended,
    close() {
      logs.close();
      conn.close();
    },
  };
}

test(
  "a link that drops mid-stream ends the stream as unreachable",
  { timeout: 15_000 },
  async () => {
    const up = linkUp();
    const link = await agent.link(door);
    await up;
    const stream = await followLogs();

    link.drop();
    assert.equal(await stream.ended, "unreachable");
    stream.close();
  },
);

test(
  "a link that goes silent is cut, and the stream on it ends as unreachable",
  { timeout: 15_000 },
  async () => {
    await stopAgentLinkListener();
    door = (
      await startAgentLinkListener({
        port: 0,
        host: "127.0.0.1",
        watchdogMs: 1_000,
      })
    ).port;
    const up = linkUp();
    const link = await agent.link(door, { pingEveryMs: 100 });
    await up;
    const stream = await followLogs();

    link.freeze();
    assert.equal(await stream.ended, "unreachable");
    stream.close();
  },
);

test("removing a server closes its link and turns its agent away", async () => {
  process.env.DEPLO_PUBLIC_URL = "https://deplo.test";
  await pg.exec(TRUNCATE_IDENTITY);
  await seedIdentity(db, {
    users: [{ id: USER_1, teamId: TEAM_A, role: "owner" }],
  });
  const up = linkUp();
  const link = await agent.link(door);
  await up;

  await runWithIdentity({ userId: USER_1, teamId: TEAM_A }, () =>
    removeServer(SERVER),
  );
  assert.equal(await link.closed, LINK_CLOSE.revoked);
  assert.equal((await agent.link(door)).status, 404);
  await assert.rejects(connectAgent(SERVER), AgentUnreachableError);
});

test("a renewed certificate closes the link it verified, and the agent relinks with the new one", async () => {
  let up = linkUp();
  const link = await agent.link(door);
  await up;
  const old = agent.fingerprint;

  await renewAgentCert(SERVER, ["127.0.0.1"]);
  assert.equal(await link.closed, LINK_CLOSE.revoked);
  assert.equal((await knock(door, { claim: old })).status, 404);
  up = linkUp();
  assert.equal((await agent.link(door)).status, 101);
  await up;
  assert.equal(await helloOver(), AGENT_VERSION);
  assert.equal(agent.connections().opened, 0, "it never dialed the agent");
});

test("enrolling a server again closes the link of the agent it replaces", async () => {
  const up = linkUp();
  const link = await agent.link(door);
  await up;
  const { rawToken, stored } = mintBootstrap();
  await db
    .update(servers)
    .set({
      bootstrapTokenHash: stored.tokenHash,
      bootstrapExpiresAt: stored.expiresAt,
      bootstrapUsedAt: null,
    })
    .where(eq(servers.id, SERVER));

  await completeBootstrap({ token: rawToken, csrPem: await makeCsr() });
  assert.equal(await link.closed, LINK_CLOSE.revoked);
  assert.equal((await agent.link(door)).status, 404);
});

test("stopping the listener closes every link and the door", async () => {
  const up = linkUp();
  const link = await agent.link(door);
  await up;

  await stopAgentLinkListener();
  assert.equal(await link.closed, LINK_CLOSE.stopping);
  await assert.rejects(knock(door), { code: "ECONNREFUSED" });
});

test("server status hears a link come up and go down, and nothing for a replacement", async (t) => {
  const events: string[] = [];
  t.after(onAgentLink((e) => events.push(`${e.type} ${e.serverId}`)));
  let up = linkUp();
  const first = await agent.link(door);
  await up;
  up = linkUp();
  const second = await agent.link(door);
  await up;
  await first.closed;

  const down = linkDown();
  second.drop();
  await down;
  assert.deepEqual(events, [`up ${SERVER}`, `up ${SERVER}`, `down ${SERVER}`]);
});

test("a server whose agent does not link is dialed directly, as today", async () => {
  assert.equal(await helloOver(), AGENT_VERSION);
  assert.equal(agent.connections().opened, 1);
});

async function stopListeningDirectly(): Promise<void> {
  const nobody = net.createServer();
  await new Promise<void>((r) => nobody.listen(0, "127.0.0.1", r));
  const { port } = nobody.address() as net.AddressInfo;
  await new Promise((r) => nobody.close(r));
  await db
    .update(servers)
    .set({ agentPort: port })
    .where(eq(servers.id, SERVER));
}

test("right after the panel starts, a server whose agent is relinking is waited for", async () => {
  await stopListeningDirectly();
  const call = helloOver();
  await new Promise((r) => setTimeout(r, 300));
  const up = linkUp();
  await agent.link(door);
  await up;
  assert.equal(await call, AGENT_VERSION);
});

test("once the panel has settled, a server that never linked fails at once, as today", async (t) => {
  await stopListeningDirectly();
  mock.timers.enable({ apis: ["Date"], now: Date.now() + LINK_SETTLE_MS });
  t.after(() => mock.timers.reset());

  const started = performance.now();
  await assert.rejects(connectAgent(SERVER), AgentUnreachableError);
  assert.ok(performance.now() - started < 3_000);
});

const stillOpen = (link: FakeLink) =>
  Promise.race([link.closed, new Promise((r) => setTimeout(r, 100, "open"))]);

test("an impostor is closed and never displaces the verified link", async (t) => {
  const up = linkUp();
  const real = await agent.link(door);
  await up;
  // Another server's certificate: issued by the same CA, but not the one this server pins.
  const impostor = await startFakeAgent({ version: "9.9.9" });
  t.after(() => impostor.stop());

  const fake = await impostor.link(door, { claim: agent.fingerprint });
  assert.equal(fake.status, 101, "only the handshake can tell");
  assert.equal(await fake.closed, LINK_CLOSE.refused);
  assert.equal(await stillOpen(real), "open");
  assert.equal(await helloOver(), AGENT_VERSION);
  assert.equal(impostor.connections().opened, 0);
});
