import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { runWithIdentity } from "../auth/request-context";
import { seedIdentity, TEAM_A, USER_1 } from "./identity-test-helpers";
import { seedServer, TRUNCATE_PROJECT_GRAPH } from "./app-graph-test-helpers";
import { seedServerRow } from "./infra-test-helpers";
import {
  clusterMembers,
  clusterNetworkLinks,
  clusterNetworkPeers,
  clusters as clustersTable,
} from "../db/schema/control-plane/clusters";
import { deploMoves } from "../db/schema/control-plane/deplo-move";
import { servers as serversTable } from "../db/schema/control-plane/servers";
import { __resetReleaseCacheForTests } from "../agent/release";
import { __setClusterPinForTest } from "../infra/agent-client/cluster-host";
import {
  fakeClusterHosts,
  type FakeClusterHost,
} from "../infra/agent-client/cluster-test-helpers";
import {
  CLUSTER_NETWORK_CAPABILITY,
  NETWORK_ROTATE_CAPABILITY,
} from "../infra/agent-client/hello-capabilities";
import { networkAddress } from "../deploy/cluster-network";
import { createCluster } from "./clusters/manage";
import { addClusterMember, listClusterMembers } from "./clusters/members";
import {
  reconcileClusterNetworks,
  retireNetworkKey,
  rotateNetworkKey,
  syncClusterNetwork,
} from "./clusters/network";
import { clusterRoster } from "./clusters/relay";
import { removeServer } from "./servers/removal";
import { invalidateFrozen } from "./deplo-move/freeze";
import { turnOnExperiments } from "./experiments-test-helpers";

let db: TestDb;
let pg: PGlite;
let fleet: ReturnType<typeof fakeClusterHosts>;
let hosts: Record<string, FakeClusterHost>;
let origFetch: typeof fetch;

const SUMS =
  `${"a".repeat(64)}  deplo-cluster-linux-amd64\n` +
  `${"b".repeat(64)}  deplo-cluster-linux-arm64\n`;
const everyone = { allTeams: true, teamIds: [] as string[] };
const fp = (n: number) => String(n).repeat(64);
const MEMBERS = ["srv_2", "srv_3"];

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
});

after(async () => {
  __resetTestDb();
  await pg.close();
});

beforeEach(async () => {
  await pg.exec(`${TRUNCATE_PROJECT_GRAPH}
    truncate table clusters, cluster_network_peers, cluster_network_links, activities, registration_links, membership_capabilities, memberships, users, teams restart identity cascade;`);
  await seedIdentity(db, {
    users: [{ id: USER_1, teamId: TEAM_A, role: "owner" }],
  });
  await turnOnExperiments(db, "clusters");
  // srv_1 is Deplo's own machine: it leads the cluster and stands in for any other leader.
  await seedServer(db, undefined, { deploHost: true });
  process.env.DEPLO_SERVER_IP = "10.0.0.1";
  await db
    .update(serversTable)
    .set({ agentCertFingerprint: fp(1) })
    .where(eq(serversTable.id, "srv_1"));
  for (const [i, id] of MEMBERS.entries()) {
    await seedServerRow(db, {
      id,
      ip: `10.0.0.${i + 2}`,
      host: `10.0.0.${i + 2}`,
    });
    await db
      .update(serversTable)
      .set({ agentCertFingerprint: fp(i + 2) })
      .where(eq(serversTable.id, id));
  }
  fleet = fakeClusterHosts();
  hosts = {};
  const capabilities = (h: FakeClusterHost) => [
    ...h.capabilities,
    CLUSTER_NETWORK_CAPABILITY,
  ];
  hosts.srv_1 = fleet.host("srv_1", {
    status: {
      installed: true,
      running: true,
      version: "0.2.0",
      relay: true,
      member: false,
      relayLinks: 0,
    },
  });
  for (const id of MEMBERS) hosts[id] = fleet.host(id);
  for (const h of Object.values(hosts)) h.capabilities = capabilities(h);
  __setClusterPinForTest({ version: "0.2.0", min: "0.2.0" });
  __resetReleaseCacheForTests();
  origFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(SUMS)) as typeof fetch;
  invalidateFrozen();
});

afterEach(async () => {
  fleet.restore();
  __setClusterPinForTest(null);
  __resetReleaseCacheForTests();
  globalThis.fetch = origFetch;
  await db.delete(deploMoves);
  invalidateFrozen();
});

const asAdmin = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);

async function eu() {
  const c = await asAdmin(() => createCluster("eu", everyone));
  for (const m of MEMBERS) await asAdmin(() => addClusterMember(c.id, m));
  return c;
}

const last = (h: FakeClusterHost) =>
  h.networkTables[h.networkTables.length - 1];

test("every server of a cluster, and Deplo's machine that leads it, is handed every other one with its key", async () => {
  const c = await eu();
  await syncClusterNetwork(c.id);
  for (const [id, h] of Object.entries(hosts)) {
    const t = last(h);
    assert.equal(t.clusterId, c.id);
    assert.equal(t.address, networkAddress(id));
    const others = Object.keys(hosts).filter((o) => o !== id);
    assert.deepEqual(
      t.peers.map((p) => p.publicKey).sort(),
      others.map((o) => `key-${o}`).sort(),
      `${id}'s peers`,
    );
  }
  // srv_3 is tried on the address Deplo knows it by and on the one its agent named, at the port it answered with.
  const toSrv3 = last(hosts.srv_2).peers.find((p) => p.fingerprint === fp(3))!;
  assert.ok(
    toSrv3.endpoints.includes("10.0.0.3:51820"),
    toSrv3.endpoints.join(" "),
  );
  const keys = await db.select().from(clusterNetworkPeers);
  assert.equal(keys.length, 3);
});

test("a pass with nothing new is one call per server", async () => {
  const c = await eu();
  await syncClusterNetwork(c.id);
  const before = Object.values(hosts).map((h) => h.networkTables.length);
  await syncClusterNetwork(c.id);
  assert.deepEqual(
    Object.values(hosts).map((h) => h.networkTables.length),
    before.map((n) => n + 1),
  );
});

test("an agent too old for the network stays off it and the others are not handed it", async () => {
  hosts.srv_3.capabilities = hosts.srv_3.capabilities.filter(
    (c) => c !== CLUSTER_NETWORK_CAPABILITY,
  );
  const c = await eu();
  await syncClusterNetwork(c.id);
  assert.equal(hosts.srv_3.networkTables.length, 0);
  assert.ok(!last(hosts.srv_2).peers.some((p) => p.fingerprint === fp(3)));
});

test("a server that leaves the cluster is taken off the network, and the others stop being handed it", async () => {
  const c = await eu();
  await syncClusterNetwork(c.id);
  await db.delete(clusterMembers).where(eq(clusterMembers.serverId, "srv_3"));
  await syncClusterNetwork(c.id);
  assert.deepEqual(last(hosts.srv_3).peers, []);
  assert.ok(!last(hosts.srv_2).peers.some((p) => p.fingerprint === fp(3)));
  const left = await db
    .select()
    .from(clusterNetworkPeers)
    .where(eq(clusterNetworkPeers.serverId, "srv_3"));
  assert.equal(left.length, 0);
});

// c44: a removed member stayed every peer's for 8 min 17 s, until a sweep that waited behind a slow tick.
test("a server removed from Deplo leaves every peer's network without waiting for the sweep", async () => {
  const c = await eu();
  await syncClusterNetwork(c.id);
  await asAdmin(() => removeServer("srv_3"));
  const gone = () =>
    ["srv_1", "srv_2"].every(
      (id) => !last(hosts[id]).peers.some((p) => p.fingerprint === fp(3)),
    );
  for (let i = 0; i < 100 && !gone(); i++)
    await new Promise((r) => setTimeout(r, 20));
  assert.ok(gone(), "srv_3 is still handed to its old peers");
});

test("a deleted cluster's servers are taken off its network by the sweep", async () => {
  const c = await eu();
  await syncClusterNetwork(c.id);
  await db.delete(clustersTable).where(eq(clustersTable.id, c.id));
  await reconcileClusterNetworks();
  for (const h of Object.values(hosts)) assert.deepEqual(last(h).peers, []);
  assert.equal((await db.select().from(clusterNetworkPeers)).length, 0);
});

test("a server that cannot be told it left keeps its row, so the next pass tries again", async () => {
  const c = await eu();
  await syncClusterNetwork(c.id);
  await db.delete(clusterMembers).where(eq(clusterMembers.serverId, "srv_3"));
  hosts.srv_3.unreachable = true;
  await syncClusterNetwork(c.id);
  const kept = await db
    .select()
    .from(clusterNetworkPeers)
    .where(eq(clusterNetworkPeers.serverId, "srv_3"));
  assert.equal(kept.length, 1);
});

test("a server's card names who it reaches only through the relay, or not at all", async () => {
  const c = await eu();
  hosts.srv_2.networkPath = (f) =>
    f === fp(3) ? "relay" : f === fp(1) ? "none" : "direct";
  await syncClusterNetwork(c.id);
  const members = await asAdmin(() => listClusterMembers(c.id));
  const srv2 = members.find((m) => m.serverId === "srv_2")!;
  assert.deepEqual(srv2.network, {
    relayed: ["srv_3"],
    unreachable: ["Deplo's machine"],
  });
  const srv3 = members.find((m) => m.serverId === "srv_3")!;
  assert.deepEqual(srv3.network, { relayed: [], unreachable: [] });
  const links = await db
    .select()
    .from(clusterNetworkLinks)
    .where(eq(clusterNetworkLinks.serverId, "srv_2"));
  assert.equal(links.length, 2);
});

test("the relay lets a leader's server through as a member too, for the network's packets", async () => {
  const c = await eu();
  const roster = await clusterRoster(c.id, MEMBERS);
  assert.ok(
    roster.parties.some((p) => p.fingerprint === fp(1) && p.role === "leader"),
  );
  assert.ok(
    roster.parties.some((p) => p.fingerprint === fp(1) && p.role === "member"),
  );
  assert.equal(
    roster.parties.filter((p) => p.fingerprint === fp(2) && p.role === "member")
      .length,
    1,
  );
});

// ADR-0050 decision 6: a caught copy holds its original's network key, so the original gets a new one and every
// other server is handed it in the same pass; the old one is named nowhere after.
test("a caught copy's network key is replaced once and the others are handed the new one", async () => {
  const c = await eu();
  await syncClusterNetwork(c.id);
  await retireNetworkKey("srv_2");
  assert.equal(
    last(hosts.srv_2).retirePublicKey,
    undefined,
    "asked once, then never again",
  );
  assert.equal(
    hosts.srv_2.networkTables.filter((t) => t.retirePublicKey === "key-srv_2")
      .length,
    1,
  );
  assert.equal(hosts.srv_2.networkKey, "key-srv_2+");
  for (const id of ["srv_1", "srv_3"])
    assert.deepEqual(
      last(hosts[id]).peers.find((p) => p.fingerprint === fp(2))?.publicKey,
      "key-srv_2+",
      id,
    );
  await syncClusterNetwork(c.id);
  assert.equal(hosts.srv_2.networkKey, "key-srv_2+");
});

// A copy installed as a new server can answer with the key of the server it was copied from: it is given its own
// in the same call, the original keeps its key, and nobody is handed the copied one.
test("a new server that answers with another server's network key gets one of its own before anyone learns it", async () => {
  const c = await eu();
  await syncClusterNetwork(c.id);
  hosts.srv_3.networkKey = hosts.srv_2.networkKey;
  await db
    .delete(clusterNetworkPeers)
    .where(eq(clusterNetworkPeers.serverId, "srv_3"));
  await syncClusterNetwork(c.id);
  assert.equal(hosts.srv_2.networkKey, "key-srv_2", "the original keeps it");
  assert.equal(hosts.srv_3.networkKey, "key-srv_2+");
  const stored = await db
    .select({
      id: clusterNetworkPeers.serverId,
      key: clusterNetworkPeers.publicKey,
    })
    .from(clusterNetworkPeers)
    .where(eq(clusterNetworkPeers.clusterId, c.id));
  assert.deepEqual(
    Object.fromEntries(stored.map((r) => [r.id, r.key])).srv_3,
    "key-srv_2+",
  );
  for (const id of ["srv_1", "srv_2"])
    assert.deepEqual(
      last(hosts[id]).peers.find((p) => p.fingerprint === fp(3))?.publicKey,
      "key-srv_2+",
      id,
    );
});

// c46 printed eu-1's network key: a new one reaches every peer as its next key before the server switches to it.
test("a network key is rotated with every peer told the next key first", async () => {
  const c = await eu();
  await syncClusterNetwork(c.id);
  for (const h of Object.values(hosts))
    h.capabilities.push(NETWORK_ROTATE_CAPABILITY);
  const before = hosts.srv_2.networkTables.length;
  const told = (id: string) =>
    hosts[id].networkTables.some(
      (t) =>
        t.peers.find((p) => p.fingerprint === fp(2))?.nextPublicKey ===
        "key-srv_2-next",
    );
  const asked = hosts.srv_2.networkTables;
  const at = () => asked.findIndex((t) => t.rotateToPublicKey);
  assert.equal(await rotateNetworkKey("srv_2"), "key-srv_2-next");
  assert.ok(
    asked.slice(before).some((t) => t.nextKey),
    "the next key made first",
  );
  assert.ok(at() > before, "then the switch");
  for (const id of ["srv_1", "srv_3"]) {
    assert.ok(told(id), `${id} told the next key`);
    assert.equal(
      last(hosts[id]).peers.find((p) => p.fingerprint === fp(2))?.publicKey,
      "key-srv_2-next",
      id,
    );
  }
  const [row] = await db
    .select({ key: clusterNetworkPeers.publicKey })
    .from(clusterNetworkPeers)
    .where(eq(clusterNetworkPeers.serverId, "srv_2"));
  assert.equal(row?.key, "key-srv_2-next");
});

test("a network key is not rotated while a peer's agent cannot take it with its tunnels up", async () => {
  const c = await eu();
  await syncClusterNetwork(c.id);
  hosts.srv_2.capabilities.push(NETWORK_ROTATE_CAPABILITY);
  await assert.rejects(rotateNetworkKey("srv_2"), /too old/);
  assert.ok(!hosts.srv_2.networkTables.some((t) => t.nextKey));
  assert.equal(hosts.srv_2.networkKey, "key-srv_2");
});
