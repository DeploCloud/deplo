import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";

import type { PGlite } from "@electric-sql/pglite";
import * as x509 from "@peculiar/x509";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../../db/test-harness";
import { __setTestDb, __resetTestDb } from "../../db/client";
import {
  serverRetiredCerts,
  servers,
} from "../../db/schema/control-plane/servers";
import { seedServerRow, TRUNCATE_INFRA } from "../../data/infra-test-helpers";
import {
  seedIdentity,
  TEAM_A,
  TRUNCATE_IDENTITY,
  USER_1,
} from "../../data/identity-test-helpers";
import { completeBootstrap } from "../../data/servers/agent-handshake";
import {
  __setCopyAlertForTest,
  recordLinkOrigin,
} from "../../data/servers/agent-identity";
import { connectsFromElsewhere } from "../../data/servers/addresses";
import { addServer } from "../../data/servers/enrollment";
import { getServerById } from "../../data/servers/roster";
import { runWithIdentity } from "../../auth/request-context";
import { issueAgentServerCert } from "../../agent/pki";
import { AGENT_VERSION } from "../../version";
import { connectAgent } from "../agent-client/connect";
import { dropAgentChannel } from "../agent-client/channel-pool";
import {
  eventually,
  startFakeAgent,
  type FakeAgent,
} from "../agent-client/fake-agent-test-helpers";
import { HOST_ADDRESSES_CAPABILITY } from "../agent-client/hello-capabilities";
import { startAgentLinkListener, stopAgentLinkListener } from "./listener";
import { LINK_CLOSE } from "./protocol";
import { currentLink, onAgentLink } from "./registry";

// ADR-0050: a server is known by its agent's key, never by its address.

let db: TestDb;
let pg: PGlite;
let door: number;
let alerts: { serverId: string; key: string; title: string; body: string }[];
const started: FakeAgent[] = [];

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
  await pg.exec(TRUNCATE_IDENTITY);
  await pg.exec("truncate table rate_limits");
  await seedIdentity(db, {
    users: [{ id: USER_1, teamId: TEAM_A, role: "owner" }],
  });
  alerts = [];
  __setCopyAlertForTest((serverId, a) => void alerts.push({ serverId, ...a }));
  door = (await startAgentLinkListener({ port: 0, host: "127.0.0.1" })).port;
});

afterEach(async () => {
  __setCopyAlertForTest();
  await stopAgentLinkListener();
  for (const a of started.splice(0)) await a.stop();
});

async function fake(opts: Parameters<typeof startFakeAgent>[0] = {}) {
  const a = await startFakeAgent(opts);
  started.push(a);
  return a;
}

async function enrolled(id: string, agent: FakeAgent, ip = "") {
  await seedServerRow(db, {
    id,
    ip,
    host: ip,
    agent: {
      certFingerprint: agent.fingerprint,
      certPem: agent.certPem,
      version: AGENT_VERSION,
    },
  });
  dropAgentChannel(id);
}

function linkUp(serverId: string): Promise<void> {
  return new Promise((resolve) => {
    const off = onAgentLink((e) => {
      if (e.serverId !== serverId || e.type !== "up") return;
      off();
      resolve();
    });
  });
}

async function helloOver(serverId: string): Promise<string> {
  const conn = await connectAgent(serverId);
  try {
    return (await conn.hello()).agentVersion;
  } finally {
    conn.close();
  }
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

const asOwner = <T>(fn: () => Promise<T>) =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);

test("a certificate past its date links with no reinstall, and gets a new key at once", async () => {
  const agent = await fake({ identity: await aged(400, -35) });
  await enrolled("srv_off", agent);
  const old = agent.fingerprint;

  const up = linkUp("srv_off");
  const link = await agent.link(door);
  assert.equal(link.status, 101);
  await up;
  // The key it proved was rotated over that link, which stays open.
  await eventually(() => agent.fingerprint !== old, 5_000);
  assert.equal(await helloOver("srv_off"), AGENT_VERSION);
  link.drop();
  const [row] = await db
    .select()
    .from(servers)
    .where(eq(servers.id, "srv_off"));
  assert.equal(row.agentCertFingerprint, agent.fingerprint);
  assert.ok(
    new Date(new x509.X509Certificate(row.agentCertPem!).notAfter) > new Date(),
  );

  await eventually(() => !currentLink("srv_off"));
  const again = linkUp("srv_off");
  assert.equal((await agent.link(door)).status, 101);
  await again;
  assert.equal(await helloOver("srv_off"), AGENT_VERSION);
});

test("a copy that missed a rotation is refused and flagged, and the original keeps working", async () => {
  const identity = await aged(40, 300);
  const original = await fake({ identity });
  await enrolled("srv_vm", original);
  // A virtual machine cloned with the agent inside, then left off while the original rotated.
  const copy = await fake({ identity });
  await rotated("srv_vm", original);

  const refused = await copy.link(door);
  assert.equal(refused.status, 101, "only the handshake can tell");
  assert.equal(await refused.closed, LINK_CLOSE.copied);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].key, "server_identity_copied");
  assert.equal(
    alerts[0].title,
    "Two machines are using the identity of srv_vm",
  );
  assert.match(alerts[0].body, /gave up when Deplo last renewed it/);
  assert.match(alerts[0].body, /run the install command of a new server/);
  assert.equal(await helloOver("srv_vm"), AGENT_VERSION);
  assert.equal(
    (await db.select().from(serverRetiredCerts)).length,
    1,
    "the old key is kept, so a copy is recognised",
  );
});

test("a copy caught beside the original is locked out for good: the original gets a new key at once", async () => {
  // A key a day old, nowhere near its rotation.
  const identity = await aged(1, 364);
  const original = await fake({ identity });
  await enrolled("srv_vm", original);
  const up = linkUp("srv_vm");
  const kept = await original.link(door);
  await up;
  const old = original.fingerprint;

  const copy = await fake({ identity });
  assert.equal(await (await copy.link(door)).closed, LINK_CLOSE.copied);
  await eventually(() => original.fingerprint !== old, 5_000);
  assert.ok(currentLink("srv_vm"), "the original's link stays");
  assert.equal(await helloOver("srv_vm"), AGENT_VERSION);

  // The original goes off: its link no longer answers, and the copy still is refused.
  kept.drop();
  await eventually(() => !currentLink("srv_vm"));
  assert.equal(await (await copy.link(door)).closed, LINK_CLOSE.copied);
  assert.match(alerts.at(-1)!.body, /gave up when Deplo last renewed it/);
});

test("a stranger presenting a retired fingerprint without its key is refused and flags nothing", async () => {
  const original = await fake({ identity: await aged(40, 300) });
  await enrolled("srv_vm", original);
  const retired = await rotated("srv_vm", original);

  const stranger = await fake();
  const link = await stranger.link(door, { claim: retired });
  assert.equal(await link.closed, LINK_CLOSE.refused);
  assert.equal(alerts.length, 0);
});

test("two servers behind one public address enroll and both work", async () => {
  const added = await asOwner(async () => [
    await addServer({ name: "pve-1" }),
    await addServer({ name: "pve-2" }),
  ]);
  for (const { server } of added) {
    assert.equal(server.ip, "", "no address is typed");
    await db
      .update(servers)
      .set({ bootstrapUsedAt: null })
      .where(eq(servers.id, server.id));
  }
  for (const { installCommand, server } of added) {
    const token = /echo '([^']+)'/.exec(installCommand)![1];
    await completeBootstrap({
      token,
      csrPem: await makeCsr(),
      connectedFrom: "198.51.100.20",
    });
    const row = await getServerById(server.id);
    assert.equal(row?.connectedFrom, "198.51.100.20");
  }

  // Each machine's own key links it, from the same address as the other.
  const agents = await Promise.all([
    fake({ capabilities: [HOST_ADDRESSES_CAPABILITY] }),
    fake({ capabilities: [HOST_ADDRESSES_CAPABILITY] }),
  ]);
  for (const [i, { server }] of added.entries()) {
    await db
      .update(servers)
      .set({
        agentCertFingerprint: agents[i].fingerprint,
        agentCertPem: agents[i].certPem,
      })
      .where(eq(servers.id, server.id));
    const up = linkUp(server.id);
    await agents[i].link(door);
    await up;
  }
  for (const { server } of added) {
    assert.ok(currentLink(server.id), `${server.name} is linked`);
    assert.equal(await helloOver(server.id), AGENT_VERSION);
  }
});

test("Connected from is never read from a header a direct connection sends", async () => {
  const agent = await fake();
  await enrolled("srv_here", agent, "203.0.113.9");
  const up = linkUp("srv_here");
  await agent.link(door, { forwardedFor: "192.0.2.66" });
  await up;
  const row = await getServerById("srv_here");
  assert.equal(row?.connectedFrom, "127.0.0.1");
});

test("a server added without an address takes the public address its agent reports", async () => {
  const agent = await fake({
    capabilities: [HOST_ADDRESSES_CAPABILITY],
    publicAddresses: ["2001:db8::7", "203.0.113.7"],
  });
  await enrolled("srv_new", agent);
  const up = linkUp("srv_new");
  await agent.link(door);
  await up;
  const row = await getServerById("srv_new");
  assert.equal(row?.ip, "203.0.113.7");
  assert.equal(row?.host, "203.0.113.7");

  // One a person set under Advanced is never overwritten.
  await db
    .update(servers)
    .set({ ip: "10.1.2.3", host: "10.1.2.3" })
    .where(eq(servers.id, "srv_new"));
  currentLink("srv_new")?.close(LINK_CLOSE.replaced, "test");
  const again = linkUp("srv_new");
  await agent.link(door);
  await again;
  assert.equal((await getServerById("srv_new"))?.ip, "10.1.2.3");
});

test("behind a router is decided with the agent's own addresses, so a dual-stack server on its IPv6 is not", async () => {
  await seedServerRow(db, {
    id: "srv_dual",
    ip: "203.0.113.9",
    host: "203.0.113.9",
  });
  await recordLinkOrigin("srv_dual", "2001:db8::5", [
    "203.0.113.9",
    "2001:db8::5",
  ]);
  let row = (await getServerById("srv_dual"))!;
  assert.equal(row.connectedFrom, "2001:db8::5");
  assert.equal(connectsFromElsewhere(row), null);

  // A virtual machine with only a private address, reached through its router's.
  await recordLinkOrigin("srv_dual", "198.51.100.20", []);
  row = (await getServerById("srv_dual"))!;
  assert.equal(connectsFromElsewhere(row), "198.51.100.20");

  await seedServerRow(db, { id: "srv_lan", ip: "", host: "" });
  await recordLinkOrigin("srv_lan", "198.51.100.20", []);
  assert.equal(
    connectsFromElsewhere((await getServerById("srv_lan"))!),
    "198.51.100.20",
  );
  await recordLinkOrigin("srv_lan", "127.0.0.1", []);
  assert.equal(connectsFromElsewhere((await getServerById("srv_lan"))!), null);
});

// A certificate whose key is a rotation old or more: linking with it rotates the key at once.
function aged(daysOld: number, daysLeft: number) {
  const day = 24 * 3_600_000;
  return issueAgentServerCert(["127.0.0.1"], {
    notBefore: new Date(Date.now() - daysOld * day),
    notAfter: new Date(Date.now() + daysLeft * day),
  });
}

// Links, lets the door rotate the key it proved, and links again with the new one.
async function rotated(id: string, agent: FakeAgent): Promise<string> {
  const old = agent.fingerprint;
  const link = await agent.link(door);
  await eventually(() => agent.fingerprint !== old, 5_000);
  link.drop();
  await eventually(() => !currentLink(id));
  const up = linkUp(id);
  await agent.link(door);
  await up;
  return old;
}
