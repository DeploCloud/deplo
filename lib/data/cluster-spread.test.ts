import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { asc, eq } from "drizzle-orm";
import { parse } from "yaml";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { runWithIdentity } from "../auth/request-context";
import { encryptSecret } from "../crypto";
import { seedIdentity, TEAM_A, TEAM_B, USER_1 } from "./identity-test-helpers";
import {
  seedApp,
  seedDeployment,
  seedServer,
  SERVER_1,
  TRUNCATE_PROJECT_GRAPH,
} from "./app-graph-test-helpers";
import { seedServerRow } from "./infra-test-helpers";
import { apps as appsTable } from "../db/schema/control-plane/apps";
import { workloadPlacements } from "../db/schema/control-plane/clusters";
import {
  deploymentLogs,
  deployments as deploymentsTable,
} from "../db/schema/control-plane/deployments";
import {
  appTunnelDomains,
  appTunnels,
  dnsProviders,
} from "../db/schema/control-plane/dns-providers";
import { domains } from "../db/schema/control-plane/domains";
import { servers as serversTable } from "../db/schema/control-plane/servers";
import { __resetReleaseCacheForTests } from "../agent/release";
import type { DeployRequest } from "../agent/gen/agent";
import { __setClusterPinForTest } from "../infra/agent-client/cluster-host";
import {
  fakeClusterHosts,
  type FakeClusterHost,
} from "../infra/agent-client/cluster-test-helpers";
import { SPREAD_CAPABILITY } from "../infra/agent-client/hello-capabilities";
import { runDeploymentGuarded } from "../deploy/build/deploy-run";
import { REPLICAS_MARK } from "../deploy/failover-offer";
import { OVERLAP_CAPABILITY } from "../deploy/overlap";
import { REPLICAS_CAPABILITY } from "../deploy/replicas";
import { loadAppGraph } from "./app-graph-load";
import { flushFailoverBundles, type FailoverBundle } from "./clusters/bundles";
import { createCluster } from "./clusters/manage";
import { addClusterMember } from "./clusters/members";
import { appWaitingNote, recordPlacement } from "./clusters/placement";
import {
  replicaSpreadNote,
  SPREAD_AGENT,
  SPREAD_NO_CLOUDFLARE,
} from "./clusters/spread";
import { invalidateFrozen } from "./deplo-move/freeze";

let db: TestDb;
let pg: PGlite;
let fleet: ReturnType<typeof fakeClusterHosts>;
let hosts: Record<string, FakeClusterHost> = {};
let origFetch: typeof fetch;
const origIp = process.env.DEPLO_SERVER_IP;

const SUMS =
  `${"a".repeat(64)}  deplo-cluster-linux-amd64\n` +
  `${"b".repeat(64)}  deplo-cluster-linux-arm64\n`;
const APP = "prj_1";
const MEMBERS = ["srv_2", "srv_3", "srv_4"];
const CONNECTOR = "deplo-connector_web";
const everyone = { allTeams: true, teamIds: [] as string[] };
const enc = new TextEncoder();
const dec = new TextDecoder();
const answer = (v: unknown) => enc.encode(JSON.stringify(v));

// The leader: where it puts the replicas it is asked about, what it was asked, and the bundles sealed to it.
let leader: {
  identity: string;
  publicKey: string;
  held: Map<string, Uint8Array>;
  places: (string | null)[];
  asked: { replicas?: number; current?: string[] }[];
};
let clusterId: string;

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
    truncate table clusters, failover_bundle_pushes, dns_providers, activities, registration_links, membership_capabilities, memberships, users, teams restart identity cascade;`);
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      { id: "user_b", teamId: TEAM_B, role: "owner", isInstanceAdmin: false },
    ],
  });
  await seedServer(db);
  process.env.DEPLO_SERVER_IP = "10.0.0.1";
  for (const [i, id] of MEMBERS.entries()) {
    await seedServerRow(db, {
      id,
      ip: `10.0.0.${i + 2}`,
      host: `10.0.0.${i + 2}`,
    });
    await db
      .update(serversTable)
      .set({ agentCertFingerprint: String(i + 2).repeat(64), name: id })
      .where(eq(serversTable.id, id));
  }
  await db
    .update(serversTable)
    .set({ agentCertFingerprint: "1".repeat(64) })
    .where(eq(serversTable.id, SERVER_1));

  const age = await import("age-encryption");
  const identity = await age.generateX25519Identity();
  leader = {
    identity,
    publicKey: await age.identityToRecipient(identity),
    held: new Map(),
    places: ["srv_2", "srv_3", "srv_4"],
    asked: [],
  };
  fleet = fakeClusterHosts();
  hosts = {};
  hosts[SERVER_1] = fleet.host(SERVER_1, {
    status: {
      installed: true,
      running: true,
      version: "0.2.0",
      relay: true,
      member: false,
      relayLinks: 0,
    },
    leader: (method, payload) => {
      const body = payload.length ? JSON.parse(dec.decode(payload)) : {};
      if (method === "placement.place") {
        leader.asked.push(body);
        return answer(
          body.replicas ? { members: leader.places } : { member: "srv_2" },
        );
      }
      if (method === "leader.key")
        return answer({ publicKey: leader.publicKey });
      if (method === "leader.bundle.put") {
        leader.held.set(body.id, Buffer.from(body.sealed, "base64"));
        return answer({});
      }
      if (method === "leader.bundle.list") return answer({ bundles: [] });
      return payload;
    },
  });
  for (const id of MEMBERS) {
    hosts[id] = fleet.host(id);
    hosts[id].capabilities.push(
      "deploy.network",
      "deploy.image",
      "deploy.railpack",
      "deploy.ready-check",
      OVERLAP_CAPABILITY,
      REPLICAS_CAPABILITY,
      SPREAD_CAPABILITY,
    );
    hosts[id].extra = { listInstances: async () => [] };
  }
  __setClusterPinForTest({ version: "0.2.0", min: "0.2.0" });
  __resetReleaseCacheForTests();
  origFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(SUMS)) as typeof fetch;
  invalidateFrozen();

  // An App with three replicas on srv_2, which then joins the cluster with two more servers.
  await seedApp(db, { id: APP, slug: "web", repo: null, serverId: "srv_2" });
  await db
    .update(appsTable)
    .set({ source: "docker-image", dockerImage: "nginx:1.27", replicas: 3 })
    .where(eq(appsTable.id, APP));
  await db.insert(domains).values({
    id: "dom_1",
    appId: APP,
    name: "web.example.com",
    status: "valid",
    isPrimary: true,
    ssl: false,
    certProvider: "none",
    port: 3000,
    createdAt: "2026-11-08T00:00:00.000Z",
  });
  const cluster = await asAdmin(() => createCluster("eu", everyone));
  clusterId = cluster.id;
  for (const id of MEMBERS)
    await asAdmin(() => addClusterMember(cluster.id, id));
  await seedDeployment(db, { id: "dpl_1", appId: APP, status: "queued" });
});

afterEach(async () => {
  await flushFailoverBundles();
  fleet.restore();
  __setClusterPinForTest(null);
  __resetReleaseCacheForTests();
  globalThis.fetch = origFetch;
  if (origIp === undefined) delete process.env.DEPLO_SERVER_IP;
  else process.env.DEPLO_SERVER_IP = origIp;
  invalidateFrozen();
});

const asAdmin = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);

// The App's Cloudflare domain: its own tunnel serves it, so every server it runs on is reached.
async function withCloudflareDomain() {
  const now = "2026-11-08T00:00:00.000Z";
  await db.insert(dnsProviders).values({
    id: "dns_1",
    userId: USER_1,
    provider: "cloudflare",
    zoneName: "example.com",
    zoneId: "zone1",
    accountId: "acct1",
    apiTokenEnc: encryptSecret("cf-token"),
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(appTunnels).values({
    appId: APP,
    providerId: "dns_1",
    tunnelId: "tun_1",
    tokenEnc: encryptSecret("tunnel-token"),
    createdAt: now,
  });
  await db.insert(appTunnelDomains).values({
    domainId: "dom_1",
    appId: APP,
    providerId: "dns_1",
    active: true,
    createdAt: now,
  });
}

const placement = async () =>
  (
    await db
      .select()
      .from(workloadPlacements)
      .where(eq(workloadPlacements.workloadId, APP))
      .orderBy(asc(workloadPlacements.replica))
  ).map((r) => r.memberServerId);

const deployStatus = async (id = "dpl_1") =>
  (
    await db
      .select({ status: deploymentsTable.status })
      .from(deploymentsTable)
      .where(eq(deploymentsTable.id, id))
  )[0]?.status;

const logs = async () =>
  (await db.select().from(deploymentLogs)).map((l) => l.text).join("\n");

type Stack = {
  services: Record<
    string,
    { container_name?: string; deploy?: { replicas?: number | string } }
  >;
};
const stackOf = (req: DeployRequest) => parse(req.composeYaml) as Stack;
const app = async () => (await loadAppGraph(APP))!;

async function openBundle(): Promise<FailoverBundle> {
  await flushFailoverBundles();
  const age = await import("age-encryption");
  const d = new age.Decrypter();
  d.addIdentity(leader.identity);
  return JSON.parse(await d.decrypt(leader.held.get(APP)!, "text"));
}

test("a server that joins with an App records one placement row per replica", async () => {
  assert.deepEqual(await placement(), ["srv_2", "srv_2", "srv_2"]);
});

test("a deploy spreads the replicas of an App with a Cloudflare domain: each server gets only its own, with a connector", async () => {
  await withCloudflareDomain();
  await runDeploymentGuarded("dpl_1");

  // The leader placed them, told where each one runs now; the mirror holds one row per replica.
  assert.deepEqual(
    leader.asked.map((a) => [a.replicas, a.current]),
    [[3, ["srv_2", "srv_2", "srv_2"]]],
  );
  assert.deepEqual(await placement(), ["srv_2", "srv_3", "srv_4"]);
  assert.equal((await app()).serverId, "srv_2");
  assert.equal(await deployStatus(), "ready");

  for (const id of MEMBERS) {
    assert.equal(hosts[id].deploys.length, 1, id);
    const req = hosts[id].deploys[0]!;
    const services = stackOf(req).services;
    assert.deepEqual(Object.keys(services).sort(), [CONNECTOR, "deplo-web"]);
    assert.equal(services["deplo-web"]!.deploy?.replicas, 1);
    // No fixed name: the leader can start a lost replica beside this one without replacing it.
    assert.equal(services["deplo-web"]!.container_name, undefined);
    assert.deepEqual(req.startAfterReady, [CONNECTOR]);
    // Every new replica is ready on this server before an old one stops.
    assert.match(req.standInComposeYaml, /deplo-web_next:/);
    assert.match(req.standInComposeYaml, /replicas: 1\n/);
  }
  // srv_2 went first: nothing starts elsewhere before the first server runs the release.
  assert.match(
    await logs(),
    /Starting 1 replica on srv_3…[\s\S]*Starting 1 replica on srv_4…/,
  );
});

test("a server that takes two of three replicas renders two, the other one", async () => {
  await withCloudflareDomain();
  leader.places = ["srv_2", "srv_3", "srv_2"];
  await runDeploymentGuarded("dpl_1");

  assert.deepEqual(await placement(), ["srv_2", "srv_3", "srv_2"]);
  const count = (id: string) =>
    stackOf(hosts[id].deploys[0]!).services["deplo-web"]!.deploy?.replicas;
  assert.equal(count("srv_2"), 2);
  assert.equal(count("srv_3"), 1);
  assert.equal(hosts.srv_4.deploys.length, 0);
});

test("the failover bundle of a spread App leaves the replica count to the leader", async () => {
  await withCloudflareDomain();
  await runDeploymentGuarded("dpl_1");

  const bundle = await openBundle();
  assert.equal(bundle.deploymentId, "dpl_1");
  assert.equal(bundle.stack.scale, REPLICAS_MARK);
  const services = (parse(bundle.stack.composeYaml) as Stack).services;
  assert.equal(services["deplo-web"]!.deploy?.replicas, REPLICAS_MARK);
  assert.ok(services[CONNECTOR], "the connector starts with a moved replica");
  assert.deepEqual(bundle.stack.startAfterReady, [CONNECTOR]);
  // Putting a number where the mark is gives the stack a member is deployed.
  assert.equal(
    bundle.stack.composeYaml.replace(REPLICAS_MARK, "1"),
    hosts.srv_4.deploys[0]!.composeYaml,
  );
});

test("without a Cloudflare domain the replicas stay on one server, and the setting says why", async () => {
  await runDeploymentGuarded("dpl_1");

  assert.deepEqual(leader.asked, []);
  assert.deepEqual(await placement(), ["srv_2", "srv_2", "srv_2"]);
  assert.equal(hosts.srv_2.deploys.length, 1);
  assert.equal(hosts.srv_3.deploys.length + hosts.srv_4.deploys.length, 0);
  const services = stackOf(hosts.srv_2.deploys[0]!).services;
  assert.deepEqual(Object.keys(services), ["deplo-web"]);
  assert.equal(services["deplo-web"]!.deploy?.replicas, 3);
  assert.equal(await replicaSpreadNote(await app()), SPREAD_NO_CLOUDFLARE);
  assert.equal(
    SPREAD_NO_CLOUDFLARE,
    "Its replicas stay on one server: only a Cloudflare domain reaches every server of a cluster, so a spread would get no visitors.",
  );
  assert.equal((await openBundle()).stack.scale, undefined);
});

test("the setting says how many servers the replicas are spread across", async () => {
  await withCloudflareDomain();
  assert.equal(
    await replicaSpreadNote(await app()),
    "Spread across 3 servers: if one stops, the others keep answering",
  );
  leader.places = ["srv_2", "srv_3", "srv_2"];
  await runDeploymentGuarded("dpl_1");
  assert.equal(
    await replicaSpreadNote(await app()),
    "Spread across 2 servers: if one stops, the others keep answering",
  );
  // One replica has nothing to spread.
  await db.update(appsTable).set({ replicas: 1 }).where(eq(appsTable.id, APP));
  assert.equal(await replicaSpreadNote(await app()), null);
});

test("a server agent too old to hold one replica keeps them together and says so", async () => {
  await withCloudflareDomain();
  hosts.srv_4.capabilities = hosts.srv_4.capabilities.filter(
    (c) => c !== SPREAD_CAPABILITY,
  );
  await runDeploymentGuarded("dpl_1");

  assert.deepEqual(leader.asked, []);
  assert.deepEqual(await placement(), ["srv_2", "srv_2", "srv_2"]);
  assert.equal(hosts.srv_3.deploys.length, 0);
  assert.equal(await replicaSpreadNote(await app()), SPREAD_AGENT);
});

test("a server whose deploy fails keeps its release, the App goes on answering and the rest is not touched", async () => {
  await withCloudflareDomain();
  hosts.srv_3.extra = {
    deploy: async function* (req: DeployRequest) {
      hosts.srv_3.deploys.push(req);
      yield {
        seq: 1,
        result: {
          ready: false,
          error:
            "The new version did not start, so the old one is still online",
          commitSha: "",
          observedPort: 0,
          builtWith: "",
          listeningPorts: [],
        },
      };
    } as never,
  };
  await runDeploymentGuarded("dpl_1");

  assert.equal(await deployStatus(), "error");
  assert.equal(hosts.srv_2.deploys.length, 1);
  assert.equal(hosts.srv_4.deploys.length, 0);
  assert.match(
    await logs(),
    /srv_3 kept the previous release, so prj_1 is still answering: srv_2 runs this one\. Deploy again to finish\./,
  );
  // The placement stands: the next deploy goes to the same three servers.
  assert.deepEqual(await placement(), ["srv_2", "srv_3", "srv_4"]);
});

test("a server left with none of the replicas loses its copy of the stack", async () => {
  await withCloudflareDomain();
  await runDeploymentGuarded("dpl_1");
  await db.update(appsTable).set({ replicas: 2 }).where(eq(appsTable.id, APP));
  leader.places = ["srv_2", "srv_3"];
  await seedDeployment(db, { id: "dpl_2", appId: APP, status: "queued" });
  await runDeploymentGuarded("dpl_2");

  assert.deepEqual(await placement(), ["srv_2", "srv_3"]);
  assert.equal(await deployStatus("dpl_2"), "ready");
  assert.equal(hosts.srv_4.deploys.length, 1);
  assert.ok(hosts.srv_4.stack.includes("destroy:web"));
  assert.ok(!hosts.srv_2.stack.includes("destroy:web"));
});

test("a settled spread is deployed without asking the leader again", async () => {
  await withCloudflareDomain();
  await runDeploymentGuarded("dpl_1");
  await seedDeployment(db, { id: "dpl_2", appId: APP, status: "queued" });
  // A leader that cannot be reached must not hold up a deploy that moves nothing.
  hosts[SERVER_1].leader = () => {
    throw new Error("the leader is away");
  };
  await runDeploymentGuarded("dpl_2");

  assert.equal(await deployStatus("dpl_2"), "ready");
  assert.equal(leader.asked.length, 1);
  for (const id of MEMBERS) assert.equal(hosts[id].deploys.length, 2, id);
});

test("the replica count line shows the replicas still waiting for room", async () => {
  const record = (members: (string | null)[]) =>
    recordPlacement({
      clusterId,
      kind: "app",
      workloadId: APP,
      members,
      epoch: 1,
    });
  const note = async () => asAdmin(async () => appWaitingNote(await app()));

  assert.equal(await note(), null);
  await record(["srv_2", "srv_3", null]);
  assert.equal(await note(), "2 of 3 replicas running · waiting for room");
  await record([null, null, null]);
  assert.equal(await note(), "Waiting for room in eu");
});
