import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { parse } from "yaml";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { runWithIdentity } from "../auth/request-context";
import {
  fakeCloudflare,
  type FakeCloudflare,
} from "../cloudflare/cloudflare-test-helpers";
import { seedIdentity, TEAM_A, TEAM_B, USER_1 } from "./identity-test-helpers";
import {
  seedDeployment,
  seedServer,
  SERVER_1,
  TRUNCATE_PROJECT_GRAPH,
} from "./app-graph-test-helpers";
import { seedServerRow } from "./infra-test-helpers";
import { activities } from "../db/schema/control-plane/activity";
import {
  appTunnelDomains,
  appTunnels,
  domainDnsRecords,
} from "../db/schema/control-plane/dns-providers";
import { apps as appsTable } from "../db/schema/control-plane/apps";
import { deployments as deploymentsTable } from "../db/schema/control-plane/deployments";
import { servers as serversTable } from "../db/schema/control-plane/servers";
import { __resetReleaseCacheForTests } from "../agent/release";
import { __setClusterPinForTest } from "../infra/agent-client/cluster-host";
import {
  fakeClusterHosts,
  type FakeClusterHost,
} from "../infra/agent-client/cluster-test-helpers";
import { START_AFTER_READY_CAPABILITY } from "../infra/agent-client/hello-capabilities";
import {
  __setRunnerForTest,
  __resetQueueForTest,
} from "../deploy/deploy-queue";
import { runAgentDeploy } from "../deploy/agent-deploy";
import { applyDomainEditsMadeDuringBuild } from "../deploy/build/domain-edits-during-build";
import { rerouteApp } from "../deploy/build/reroute";
import { MASKED, redactComposeForDisplay } from "../deploy/compose-redact";
import { deleteCluster } from "./clusters/dissolve";
import { createCluster } from "./clusters/manage";
import { addClusterMember } from "./clusters/members";
import { ADDRESS_CHANGES_NOTE } from "../clusters/address-note";
import { clusterAddressNote, reconcileAppTunnels } from "./clusters/app-tunnel";
import { flushFailoverBundles, type FailoverBundle } from "./clusters/bundles";
import { invalidateFrozen } from "./deplo-move/freeze";
import { createApp } from "./apps/create";
import { deleteApp } from "./apps/delete";
import { moveAppToCluster, moveAppToServer } from "./apps/source";
import { saveDnsProvider } from "./dns-providers/store";
import { addDomain, listDomains } from "./domains/crud";
import {
  __setDnsResolve4ForTest,
  __resetDnsResolve4ForTest,
} from "./domains/dns-check";

let db: TestDb;
let pg: PGlite;
let fleet: ReturnType<typeof fakeClusterHosts>;
let hosts: Record<string, FakeClusterHost> = {};
let cf: FakeCloudflare;
let restoreCf = () => {};
let origFetch: typeof fetch;
const origIp = process.env.DEPLO_SERVER_IP;

const SUMS =
  `${"a".repeat(64)}  deplo-cluster-linux-amd64\n` +
  `${"b".repeat(64)}  deplo-cluster-linux-arm64\n`;
const COMPOSE =
  'services:\n  web:\n    image: nginx:1.27\n    expose:\n      - "80"\n';
const HOST = "app.example.com";
const USER_B = "user_b";
const CONNECTOR = "deplo-connector_web";
const everyone = { allTeams: true, teamIds: [] as string[] };
const enc = new TextEncoder();
const dec = new TextDecoder();
const answer = (v: unknown) => enc.encode(JSON.stringify(v));

// A leader with its own age identity, holding what the control plane sealed to it.
let leader: {
  identity: string;
  publicKey: string;
  held: Map<string, Uint8Array>;
  dropped: string[];
};

async function openBundle(appId: string): Promise<FailoverBundle> {
  const age = await import("age-encryption");
  const d = new age.Decrypter();
  d.addIdentity(leader.identity);
  return JSON.parse(await d.decrypt(leader.held.get(appId)!, "text"));
}

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
  // The queue re-picks a deploy that stays queued, so the stand-in for a deploy finishes it.
  __setRunnerForTest(async (depId) => {
    await db
      .update(deploymentsTable)
      .set({ status: "ready" })
      .where(eq(deploymentsTable.id, depId));
  });
  __setDnsResolve4ForTest(async () => []);
});

after(async () => {
  __resetTestDb();
  __resetQueueForTest();
  __resetDnsResolve4ForTest();
  await pg.close();
});

beforeEach(async () => {
  await pg.exec(`${TRUNCATE_PROJECT_GRAPH}
    truncate table clusters, failover_bundle_pushes, dns_providers, activities, registration_links, membership_capabilities, memberships, users, teams restart identity cascade;`);
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      { id: USER_B, teamId: TEAM_B, role: "owner", isInstanceAdmin: false },
    ],
  });
  await seedServer(db);
  process.env.DEPLO_SERVER_IP = "10.0.0.1";
  for (const [i, id] of ["srv_2", "srv_3", "srv_4"].entries()) {
    await seedServerRow(db, {
      id,
      ip: `10.0.0.${i + 2}`,
      host: `10.0.0.${i + 2}`,
    });
    await db
      .update(serversTable)
      .set({ agentCertFingerprint: String(i + 2).repeat(64) })
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
    dropped: [],
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
      if (method === "placement.place") return answer({ member: "srv_2" });
      if (method === "leader.key")
        return answer({ publicKey: leader.publicKey });
      if (method === "leader.bundle.put") {
        leader.held.set(body.id, Buffer.from(body.sealed, "base64"));
        return answer({});
      }
      if (method === "leader.bundle.drop") {
        leader.dropped.push(body.id);
        leader.held.delete(body.id);
        return answer({});
      }
      if (method === "leader.bundle.list") return answer({ bundles: [] });
      return payload;
    },
  });
  for (const id of ["srv_2", "srv_3", "srv_4"]) hosts[id] = fleet.host(id);
  __setClusterPinForTest({ version: "0.2.0", min: "0.2.0" });
  __resetReleaseCacheForTests();

  // Cloudflare is the in-memory one; the cluster release's checksums are the only other fetch.
  origFetch = globalThis.fetch;
  ({ cf, restore: restoreCf } = fakeCloudflare({
    zones: [
      { id: "zone1", name: "example.com", accountId: "acct1" },
      { id: "zone2", name: "example.org", accountId: "acct2" },
    ],
  }));
  const cloudflare = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
    String(input).startsWith("https://api.cloudflare.com")
      ? cloudflare(input, init)
      : new Response(SUMS)) as typeof fetch;
  invalidateFrozen();
});

afterEach(async () => {
  await flushFailoverBundles();
  fleet.restore();
  __setClusterPinForTest(null);
  __resetReleaseCacheForTests();
  restoreCf();
  globalThis.fetch = origFetch;
  if (origIp === undefined) delete process.env.DEPLO_SERVER_IP;
  else process.env.DEPLO_SERVER_IP = origIp;
  invalidateFrozen();
});

const asAdmin = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);
const asTeamB = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: USER_B, teamId: TEAM_B }, fn);

async function eu() {
  const cluster = await asAdmin(() => createCluster("eu", everyone));
  await asAdmin(() => addClusterMember(cluster.id, "srv_2"));
  await asAdmin(() => addClusterMember(cluster.id, "srv_3"));
  return cluster;
}

const connectCloudflare = (zone = "example.com") =>
  asAdmin(() =>
    saveDnsProvider({
      provider: "cloudflare",
      zone,
      apiToken: "cf-token-0123456789",
      teamIds: [TEAM_A],
      shared: false,
    }),
  );

// An App on a server of its own, as it is before anyone places it on a cluster.
const soloApp = (serverId = SERVER_1) =>
  asAdmin(() =>
    createApp({
      name: "web",
      source: "compose",
      repo: null,
      compose: COMPOSE,
      deploy: false,
      serverId,
    }),
  );

const withDomain = (appId: string, name = HOST) =>
  asAdmin(() => addDomain(appId, name, { service: "web", port: 80 }));

async function running(
  app: { id: string; slug: string },
  serverId: string,
  yaml: string,
) {
  hosts[serverId].stacks[app.slug] = yaml;
  await db
    .update(appsTable)
    .set({ status: "active" })
    .where(eq(appsTable.id, app.id));
}

// What a successful deploy does on the member: the stack it was handed is the one that runs there.
async function deployOn(
  app: { id: string; slug: string },
  serverId = "srv_2",
  deployId = "dpl_1",
) {
  await seedDeployment(db, { id: deployId, appId: app.id, status: "ready" });
  const result = await runAgentDeploy({
    serverId,
    deployId,
    slug: app.slug,
    appId: app.id,
    imageRef: "nginx:1.27",
    composeYaml: COMPOSE,
    network: "deplo-team-x",
    env: {},
    plan: { kind: "compose", mounts: [] },
    githubToken: "",
    sink: { log: () => {} },
  });
  assert.equal(result.ready, true);
  const req = hosts[serverId].deploys.at(-1)!;
  await running(app, serverId, req.composeYaml);
  await flushFailoverBundles();
  return req;
}

const records = (name = HOST) =>
  [...cf.records.values()]
    .filter((r) => r.name === name)
    .map((r) => ({ type: r.type, content: r.content, proxied: r.proxied }));

const activity = async (appId: string) =>
  (await db.select().from(activities).where(eq(activities.appId, appId))).map(
    (a) => a.message,
  );

const domainNamed = async (appId: string, name = HOST) =>
  (await asAdmin(() => listDomains(appId))).find((d) => d.name === name)!;

type Stack = {
  services: Record<
    string,
    {
      image?: string;
      environment?: string[];
      labels?: Record<string, string>;
      networks?: string[];
    }
  >;
};

test("a cluster App with a Cloudflare domain is deployed with its tunnel's connector, held back until it is ready", async () => {
  const cluster = await eu();
  await connectCloudflare();
  const app = await soloApp();
  await withDomain(app.id);
  await asAdmin(() => moveAppToCluster(app.id, cluster.id));

  const req = await deployOn(app);
  const [tunnelId] = [...cf.tunnels.keys()];
  const connector = (parse(req.composeYaml) as Stack).services[CONNECTOR];
  assert.match(connector.image ?? "", /^cloudflare\/cloudflared:/);
  assert.deepEqual(connector.environment, [
    `TUNNEL_TOKEN=token-for-${tunnelId}`,
  ]);
  assert.equal(connector.labels?.["deplo.start-after-ready"], "true");
  assert.deepEqual(connector.networks, ["deplo"]);
  assert.deepEqual(req.startAfterReady, [CONNECTOR]);
  // Cloudflare hands the hostname to the member's own proxy, so its routes still apply.
  assert.deepEqual(cf.tunnels.get(tunnelId)?.ingress, [
    { hostname: HOST, service: "http://deplo-traefik:80" },
    { service: "http_status:404" },
  ]);

  // Nobody reads the run token out of a stack Deplo shows.
  const shown = redactComposeForDisplay(req.composeYaml);
  assert.doesNotMatch(shown, new RegExp(`token-for-${tunnelId}`));
  assert.match(shown, new RegExp(`TUNNEL_TOKEN=${MASKED}`));
});

test("a cluster App without a Cloudflare domain gets no connector and no tunnel", async () => {
  const cluster = await eu();
  const app = await soloApp();
  await withDomain(app.id);
  await asAdmin(() => moveAppToCluster(app.id, cluster.id));

  const req = await deployOn(app);
  assert.deepEqual(Object.keys((parse(req.composeYaml) as Stack).services), [
    "web",
  ]);
  assert.deepEqual(req.startAfterReady, []);
  assert.equal(cf.tunnels.size, 0);
  assert.equal((await db.select().from(appTunnels)).length, 0);
});

test("an agent that cannot hold the connector back is refused before anything starts", async () => {
  const cluster = await eu();
  await connectCloudflare();
  const app = await soloApp();
  await withDomain(app.id);
  await asAdmin(() => moveAppToCluster(app.id, cluster.id));
  hosts.srv_2.capabilities = hosts.srv_2.capabilities.filter(
    (c) => c !== START_AFTER_READY_CAPABILITY,
  );

  await assert.rejects(
    () => deployOn(app),
    /the server agent on this server is too old to start the App's tunnel once it is ready - Deplo updates it on its own/,
  );
  assert.equal(hosts.srv_2.deploys.length, 0);
});

test("the App's failover bundle carries the run token, and only the leader's key opens it", async () => {
  const cluster = await eu();
  await connectCloudflare();
  const app = await soloApp();
  await withDomain(app.id);
  await asAdmin(() => moveAppToCluster(app.id, cluster.id));
  const req = await deployOn(app);

  const [tunnelId] = [...cf.tunnels.keys()];
  const token = `token-for-${tunnelId}`;
  const bundle = await openBundle(app.id);
  assert.equal(bundle.stack.tunnelToken, token);
  assert.deepEqual(bundle.stack.startAfterReady, [CONNECTOR]);
  assert.equal(bundle.stack.composeYaml, req.composeYaml);
  assert.doesNotMatch(
    Buffer.from(leader.held.get(app.id)!).toString("latin1"),
    new RegExp(token),
  );
  // At rest here it is ciphertext too.
  const [row] = await db.select().from(appTunnels);
  assert.doesNotMatch(row.tokenEnc, new RegExp(token));
});

test("joining switches the domain to the App's tunnel once its connector is connected, hostname unchanged", async () => {
  const cluster = await eu();
  await connectCloudflare();
  const app = await soloApp();
  const before = await withDomain(app.id);
  assert.deepEqual(records(), [
    { type: "A", content: "10.0.0.1", proxied: false },
  ]);

  await asAdmin(() => moveAppToCluster(app.id, cluster.id));
  // Nothing moves before the connector runs: the record still names the server.
  assert.deepEqual(records(), [
    { type: "A", content: "10.0.0.1", proxied: false },
  ]);
  const [tunnelId] = [...cf.tunnels.keys()];

  cf.connectedStatus = "inactive";
  await deployOn(app);
  await reconcileAppTunnels();
  assert.equal(records()[0].type, "A", "a tunnel nobody runs gets no visitors");

  cf.connectedStatus = "healthy";
  await applyDomainEditsMadeDuringBuild("dpl_1", app.id, []);
  assert.deepEqual(records(), [
    { type: "CNAME", content: `${tunnelId}.cfargotunnel.com`, proxied: true },
  ]);
  const after = await domainNamed(app.id);
  assert.equal(after.id, before.id);
  assert.equal(after.name, HOST);
  assert.equal(after.tunnel, true);
  assert.equal(after.certProvider, "cloudflare");
  const said = await activity(app.id);
  assert.ok(
    said.includes(
      "Gave web its own Cloudflare Tunnel. Its domains switch to it once it is running on the cluster",
    ),
  );
  assert.ok(
    said.includes(
      `Switched ${HOST} to web's Cloudflare Tunnel: the address stays the same wherever it runs`,
    ),
  );
});

test("a reroute keeps the connector in the stack", async () => {
  const cluster = await eu();
  await connectCloudflare();
  const app = await soloApp();
  await withDomain(app.id);
  await asAdmin(() => moveAppToCluster(app.id, cluster.id));
  await deployOn(app);
  hosts.srv_2.stacks[app.slug] = COMPOSE;

  assert.equal(await rerouteApp(app.id), "rerouted");
  const sent = parse(hosts.srv_2.reroutes[0].composeYaml) as Stack;
  assert.equal(
    sent.services[CONNECTOR].labels?.["deplo.start-after-ready"],
    "true",
  );
});

test("leaving the cluster points the domain back at the server and deletes the tunnel with its token", async () => {
  const cluster = await eu();
  await connectCloudflare();
  const app = await soloApp();
  await withDomain(app.id);
  await asAdmin(() => moveAppToCluster(app.id, cluster.id));
  await deployOn(app);
  await reconcileAppTunnels();
  assert.equal(records()[0].type, "CNAME");

  await asAdmin(() => moveAppToServer(app.id, "srv_4"));
  assert.deepEqual(records(), [
    { type: "A", content: "10.0.0.4", proxied: false },
  ]);
  const back = await domainNamed(app.id);
  assert.equal(back.name, HOST);
  assert.notEqual(back.tunnel, true);
  assert.equal(cf.tunnels.size, 0);
  assert.equal((await db.select().from(appTunnels)).length, 0);
  assert.equal((await db.select().from(appTunnelDomains)).length, 0);
  assert.deepEqual(leader.dropped, [app.id]);
  assert.ok(
    (await activity(app.id)).includes(`Pointed ${HOST} back at web's server`),
  );
  // The next stack has no connector to start.
  const req = await deployOn(app, "srv_4", "dpl_2");
  assert.deepEqual(req.startAfterReady, []);
  assert.equal(
    (parse(req.composeYaml) as Stack).services[CONNECTOR],
    undefined,
  );
});

test("deleting the cluster points the domain back at the server the App runs on and takes the connector out of its stack", async () => {
  const cluster = await eu();
  await connectCloudflare();
  const app = await soloApp();
  await withDomain(app.id);
  await asAdmin(() => moveAppToCluster(app.id, cluster.id));
  await deployOn(app);
  await reconcileAppTunnels();
  assert.equal(records()[0].type, "CNAME");
  const reroutes = hosts.srv_2.reroutes.length;

  await asAdmin(() => deleteCluster(cluster.id));
  assert.deepEqual(records(), [
    { type: "A", content: "10.0.0.2", proxied: false },
  ]);
  const back = await domainNamed(app.id);
  assert.equal(back.name, HOST);
  assert.notEqual(back.tunnel, true);
  assert.equal(cf.tunnels.size, 0);
  assert.equal((await db.select().from(appTunnels)).length, 0);
  assert.equal((await db.select().from(appTunnelDomains)).length, 0);
  assert.ok(
    (await activity(app.id)).includes(`Pointed ${HOST} back at web's server`),
  );
  // Nothing was redeployed: the stack that runs was sent again without the connector.
  assert.equal(hosts.srv_2.deploys.length, 1);
  assert.equal(hosts.srv_2.reroutes.length, reroutes + 1);
  assert.equal(
    (parse(hosts.srv_2.reroutes.at(-1)!.composeYaml) as Stack).services[
      CONNECTOR
    ],
    undefined,
  );
});

test("deleting the App deletes its tunnel, its record and its bundle", async () => {
  const cluster = await eu();
  await connectCloudflare();
  const app = await soloApp();
  await withDomain(app.id);
  await asAdmin(() => moveAppToCluster(app.id, cluster.id));
  await deployOn(app);
  await reconcileAppTunnels();

  await asAdmin(() => deleteApp(app.id));
  assert.equal(cf.tunnels.size, 0);
  assert.deepEqual(records(), []);
  assert.equal((await db.select().from(appTunnels)).length, 0);
  assert.deepEqual(leader.dropped, [app.id]);
});

test("a domain added to a cluster App in a connected zone is served by its tunnel from the start", async () => {
  const cluster = await eu();
  await connectCloudflare();
  const app = await asAdmin(() =>
    createApp({
      name: "web",
      source: "compose",
      repo: null,
      compose: COMPOSE,
      deploy: false,
      clusterId: cluster.id,
    }),
  );
  const added = await withDomain(app.id);
  const [tunnelId] = [...cf.tunnels.keys()];
  assert.equal(added.tunnel, true);
  assert.deepEqual(records(), [
    { type: "CNAME", content: `${tunnelId}.cfargotunnel.com`, proxied: true },
  ]);

  // One outside every connected zone keeps an address of its own.
  const plain = await withDomain(app.id, "web.acme.dev");
  assert.notEqual(plain.tunnel, true);
  assert.deepEqual(
    (cf.tunnels.get(tunnelId)?.ingress as { hostname?: string }[]).map(
      (r) => r.hostname,
    ),
    [HOST, undefined],
  );
});

test("an App that came with its server gets its tunnel at the join, connector first", async () => {
  await connectCloudflare();
  const app = await soloApp("srv_4");
  await withDomain(app.id);
  await running(app, "srv_4", COMPOSE);
  const cluster = await eu();
  await asAdmin(() => addClusterMember(cluster.id, "srv_4"));
  await flushFailoverBundles();

  const [tunnelId] = [...cf.tunnels.keys()];
  const first = parse(hosts.srv_4.reroutes[0].composeYaml) as Stack;
  assert.deepEqual(first.services[CONNECTOR].environment, [
    `TUNNEL_TOKEN=token-for-${tunnelId}`,
  ]);
  assert.deepEqual(records(), [
    { type: "CNAME", content: `${tunnelId}.cfargotunnel.com`, proxied: true },
  ]);
  // The sweep has nothing left to do.
  const calls = cf.calls.length;
  await reconcileAppTunnels();
  assert.equal(hosts.srv_4.reroutes.length, 2);
  assert.equal(
    cf.calls.slice(calls).filter((c) => !c.startsWith("GET")).length,
    0,
  );
});

test("a record somebody else made for the hostname is refused once, and the domain keeps its address", async () => {
  const cluster = await eu();
  await connectCloudflare();
  const app = await soloApp();
  await withDomain(app.id);
  // Their own record, pointing somewhere Deplo does not know.
  for (const [id, r] of cf.records)
    cf.records.set(id, { ...r, content: "203.0.113.9" });
  await db.delete(domainDnsRecords);
  await asAdmin(() => moveAppToCluster(app.id, cluster.id));
  await deployOn(app);

  await reconcileAppTunnels();
  await reconcileAppTunnels();
  assert.deepEqual(records(), [
    { type: "A", content: "203.0.113.9", proxied: false },
  ]);
  const refused = (await activity(app.id)).filter((m) =>
    m.startsWith("Could not switch these to web's Cloudflare Tunnel"),
  );
  assert.equal(refused.length, 1);
  assert.match(refused[0], /app\.example\.com already has a A record/);
});

test("another team's Cloudflare connection is never used for this team's App", async () => {
  const cluster = await eu();
  await asTeamB(() =>
    saveDnsProvider({
      provider: "cloudflare",
      zone: "example.com",
      apiToken: "cf-token-of-team-b-0123",
      teamIds: [TEAM_B],
      shared: true,
    }),
  );
  const app = await soloApp();
  await withDomain(app.id);
  assert.deepEqual(records(), []);
  await asAdmin(() => moveAppToCluster(app.id, cluster.id));
  const req = await deployOn(app);
  await reconcileAppTunnels();

  assert.equal(cf.tunnels.size, 0);
  assert.deepEqual(records(), []);
  assert.deepEqual(req.startAfterReady, []);
  assert.equal(
    await asAdmin(async () => clusterAddressNote(app)),
    ADDRESS_CHANGES_NOTE,
  );
});

test("the address warning shows until a Cloudflare domain covers the App, before placing and after", async () => {
  const cluster = await eu();
  const app = await soloApp();
  const note = () => asAdmin(async () => clusterAddressNote(app));
  // Before placing: a generated address, then a domain of its own nobody connected.
  assert.equal(await note(), ADDRESS_CHANGES_NOTE);
  await withDomain(app.id, "web.acme.dev");
  assert.equal(await note(), ADDRESS_CHANGES_NOTE);

  await connectCloudflare();
  await withDomain(app.id);
  assert.equal(await note(), null);

  await asAdmin(() => moveAppToCluster(app.id, cluster.id));
  await deployOn(app);
  await reconcileAppTunnels();
  assert.equal(await note(), null);
});

test("a domain in another Cloudflare account stays on its address, and Activity says so", async () => {
  const cluster = await eu();
  await connectCloudflare();
  await connectCloudflare("example.org");
  const app = await soloApp();
  await withDomain(app.id);
  await withDomain(app.id, "app.example.org");
  await asAdmin(() => moveAppToCluster(app.id, cluster.id));
  await deployOn(app);
  await reconcileAppTunnels();

  assert.equal(cf.tunnels.size, 1);
  assert.equal(records()[0].type, "CNAME");
  assert.deepEqual(records("app.example.org"), [
    { type: "A", content: "10.0.0.1", proxied: false },
  ]);
  assert.ok(
    (await activity(app.id)).some((m) =>
      m.endsWith(
        "; 1 in another Cloudflare account keep an address that changes",
      ),
    ),
  );
});
