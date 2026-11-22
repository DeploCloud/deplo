import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";

import type { PGlite } from "@electric-sql/pglite";
import * as x509 from "@peculiar/x509";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { runWithIdentity } from "../auth/request-context";
import { seedIdentity, TEAM_A, USER_1 } from "./identity-test-helpers";
import { seedServer, TRUNCATE_PROJECT_GRAPH } from "./app-graph-test-helpers";
import { seedServerRow } from "./infra-test-helpers";
import { servers as serversTable } from "../db/schema/control-plane/servers";
import { deploMoves } from "../db/schema/control-plane/deplo-move";
import { __resetReleaseCacheForTests } from "../agent/release";
import { renewAgentCertIfDue } from "../agent/cert-renewal";
import { __setClusterPinForTest } from "../infra/agent-client/cluster-host";
import {
  fakeClusterHosts,
  type FakeClusterHost,
} from "../infra/agent-client/cluster-test-helpers";
import {
  CLUSTER_NETWORK_CAPABILITY,
  CLUSTER_ROTATION_CAPABILITY,
} from "../infra/agent-client/hello-capabilities";
import { createCluster } from "./clusters/manage";
import { addClusterMember } from "./clusters/members";
import { claimedIdentity } from "./servers/agent-identity";
import { invalidateFrozen } from "./deplo-move/freeze";
import { turnOnExperiments } from "./experiments-test-helpers";

// A cluster's servers trust each other by certificate: one rotates its key only once every other holds the next.

let db: TestDb;
let pg: PGlite;
let fleet: ReturnType<typeof fakeClusterHosts>;
let hosts: Record<string, FakeClusterHost>;
let origFetch: typeof fetch;
let events: string[];

const SUMS =
  `${"a".repeat(64)}  deplo-cluster-linux-amd64\n` +
  `${"b".repeat(64)}  deplo-cluster-linux-arm64\n`;
const fp = (n: number) => String(n).repeat(64);
const MEMBERS = ["srv_2", "srv_3"];
const DAY = 24 * 3_600_000;

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
});

after(async () => {
  __resetTestDb();
  await pg.close();
});

async function certPem(from: number, to: number): Promise<string> {
  const keys = (await webcrypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as unknown as CryptoKeyPair;
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: "01",
    name: "CN=deplo-agent",
    notBefore: new Date(Date.now() + from),
    notAfter: new Date(Date.now() + to),
    keys,
    signingAlgorithm: { name: "Ed25519" },
  });
  return cert.toString("pem");
}

async function csrPem(): Promise<string> {
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

beforeEach(async () => {
  await pg.exec(`${TRUNCATE_PROJECT_GRAPH}
    truncate table clusters, cluster_network_peers, cluster_network_links, server_retired_certs, activities, registration_links, membership_capabilities, memberships, users, teams restart identity cascade;`);
  await seedIdentity(db, {
    users: [{ id: USER_1, teamId: TEAM_A, role: "owner" }],
  });
  await turnOnExperiments(db, "clusters");
  // srv_1 is Deplo's own machine: it runs the relay and leads the cluster.
  await seedServer(db, undefined, { deploHost: true });
  process.env.DEPLO_SERVER_IP = "10.0.0.1";
  await db
    .update(serversTable)
    .set({ agentCertFingerprint: fp(1) })
    .where(eq(serversTable.id, "srv_1"));
  for (const [i, id] of MEMBERS.entries()) {
    await seedServerRow(db, { id, ip: `10.0.0.${i + 2}`, host: "" });
    await db
      .update(serversTable)
      .set({ agentCertFingerprint: fp(i + 2) })
      .where(eq(serversTable.id, id));
  }
  // srv_2's key is a rotation old: due on the schedule, its date far away.
  await db
    .update(serversTable)
    .set({ agentCertPem: await certPem(-31 * DAY, 300 * DAY) })
    .where(eq(serversTable.id, "srv_2"));
  events = [];
  fleet = fakeClusterHosts();
  hosts = {
    srv_1: fleet.host("srv_1", {
      status: {
        installed: true,
        running: true,
        version: "0.2.0",
        relay: true,
        member: false,
        relayLinks: 0,
      },
    }),
  };
  for (const id of MEMBERS) hosts[id] = fleet.host(id);
  for (const [id, h] of Object.entries(hosts)) {
    h.capabilities.push(
      CLUSTER_NETWORK_CAPABILITY,
      CLUSTER_ROTATION_CAPABILITY,
    );
    h.extra.setClusterRotations = async (clusterId, rotations) => {
      if (h.unreachable) throw new Error("the server is offline");
      h.rotationTables.push({ clusterId, rotations });
      events.push(`rotations ${id}`);
      return { rotations: rotations.length };
    };
  }
  hosts.srv_1.leader = (method, payload) => {
    if (method === "relay.roster") events.push("relay");
    if (method !== "leader.roster") return payload;
    events.push("leader");
    const sent = JSON.parse(new TextDecoder().decode(payload));
    return new TextEncoder().encode(
      JSON.stringify({ ok: true, rotations: sent.rotations?.length ?? 0 }),
    );
  };
  const renewing = hosts.srv_2;
  renewing.capabilities.push("cert-renewal");
  renewing.extra.renewalCsr = async () => ({ csrPem: await csrPem() });
  renewing.extra.installRenewedCert = async () => {
    events.push("install");
    return { ok: true, error: "" };
  };
  __setClusterPinForTest({ version: "0.2.0", min: "0.2.0" });
  __resetReleaseCacheForTests();
  origFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(SUMS)) as typeof fetch;
  invalidateFrozen();
  const c = await runWithIdentity({ userId: USER_1, teamId: TEAM_A }, () =>
    createCluster("eu", { allTeams: true, teamIds: [] }),
  );
  for (const m of MEMBERS)
    await runWithIdentity({ userId: USER_1, teamId: TEAM_A }, () =>
      addClusterMember(c.id, m),
    );
  events = [];
});

afterEach(async () => {
  fleet.restore();
  __setClusterPinForTest(null);
  __resetReleaseCacheForTests();
  globalThis.fetch = origFetch;
  await db.delete(deploMoves);
  invalidateFrozen();
});

async function stored(id: string) {
  const [row] = await db
    .select({
      current: serversTable.agentCertFingerprint,
      next: serversTable.agentNextCertFingerprint,
    })
    .from(serversTable)
    .where(eq(serversTable.id, id));
  return row;
}

const lastRelayRoster = () => {
  const call = hosts.srv_1.calls.findLast((c) => c.method === "relay.roster");
  return call ? JSON.parse(new TextDecoder().decode(call.payload)) : null;
};

test("a member's key rotates only after every server, the relay and the leader hold the next one", async () => {
  const r = await renewAgentCertIfDue("srv_2");
  assert.equal(r.renewed, true, r.reason);
  const { current } = await stored("srv_2");
  assert.notEqual(current, fp(2));
  const installed = events.indexOf("install");
  for (const id of ["srv_1", "srv_2", "srv_3"]) {
    const at = events.indexOf(`rotations ${id}`);
    assert.ok(at >= 0 && at < installed, `${id} held it first: ${events}`);
    assert.deepEqual(hosts[id].rotationTables[0].rotations, [
      { from: fp(2), to: current },
    ]);
  }
  for (const what of ["relay", "leader"])
    assert.ok(events.indexOf(what) < installed, `${what} first: ${events}`);
  // After the promotion the relay knows the new key only: a copy holding the old one is cut off, and the door
  // refuses it and flags it (agent-identity.test.ts).
  const parties = lastRelayRoster().parties.map(
    (p: { fingerprint: string }) => p.fingerprint,
  );
  assert.ok(parties.includes(current) && !parties.includes(fp(2)));
  assert.equal((await claimedIdentity(fp(2)))?.kind, "retired");
});

test("a member's key waits while another server of its cluster is off, and nothing is installed", async () => {
  hosts.srv_3.unreachable = true;
  const r = await renewAgentCertIfDue("srv_2");
  assert.equal(r.renewed, false);
  const [{ name }] = await db
    .select({ name: serversTable.name })
    .from(serversTable)
    .where(eq(serversTable.id, "srv_3"));
  assert.equal(r.reason, `waiting for ${name} to hold its next key`);
  assert.ok(!events.includes("install"), `${events}`);
  assert.deepEqual(await stored("srv_2"), { current: fp(2), next: null });
  // The relay is told again without the key that was never installed.
  const parties = lastRelayRoster().parties.map(
    (p: { fingerprint: string }) => p.fingerprint,
  );
  assert.ok(parties.includes(fp(2)) && parties.length > 0);
  assert.equal(
    parties.filter((f: string) => ![fp(1), fp(2), fp(3)].includes(f)).length,
    0,
  );
});

test("an agent or a leader too old to keep a rotation holds the rotation back", async () => {
  hosts.srv_3.capabilities = hosts.srv_3.capabilities.filter(
    (c) => c !== CLUSTER_ROTATION_CAPABILITY,
  );
  assert.equal((await renewAgentCertIfDue("srv_2")).renewed, false);
  hosts.srv_3.capabilities.push(CLUSTER_ROTATION_CAPABILITY);
  hosts.srv_1.leader = (method, payload) =>
    method === "leader.roster"
      ? new TextEncoder().encode(JSON.stringify({ ok: true }))
      : payload;
  const r = await renewAgentCertIfDue("srv_2");
  assert.equal(r.renewed, false);
  assert.match(r.reason, /waiting for/);
  assert.ok(!events.includes("install"));
});

test("a key near its date rotates even while a server cannot hear of it: the others would refuse it otherwise", async () => {
  await db
    .update(serversTable)
    .set({ agentCertPem: await certPem(-300 * DAY, 10 * DAY) })
    .where(eq(serversTable.id, "srv_2"));
  hosts.srv_3.unreachable = true;
  const r = await renewAgentCertIfDue("srv_2");
  assert.equal(r.renewed, true, r.reason);
  assert.ok(events.includes("install"));
});
