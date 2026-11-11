import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { runWithIdentity } from "../auth/request-context";
import { encryptSecret } from "../crypto";
import { seedIdentity, TEAM_A, USER_1 } from "./identity-test-helpers";
import {
  seedServer,
  SERVER_1,
  TRUNCATE_PROJECT_GRAPH,
} from "./app-graph-test-helpers";
import { seedServerRow } from "./infra-test-helpers";
import { activities } from "../db/schema/control-plane/activity";
import { clusters as clustersTable } from "../db/schema/control-plane/clusters";
import { servers as serversTable } from "../db/schema/control-plane/servers";
import { __resetReleaseCacheForTests } from "../agent/release";
import { __setClusterPinForTest } from "../infra/agent-client/cluster-host";
import {
  fakeClusterHosts,
  type FakeClusterHost,
} from "../infra/agent-client/cluster-test-helpers";
import { fakeCloudflare } from "../cloudflare/cloudflare-test-helpers";
import {
  panelTunnelReachesHost,
  withPanelTunnel,
} from "../deploy/panel-tunnel-stack";
import { panelRoute, withPanelRoute } from "../deploy/traefik-stack";
import { createCluster } from "./clusters/manage";
import { ensureClusterLeader } from "./clusters/leader";
import {
  clusterRoster,
  pushClusterRoster,
  pushRostersForServer,
  reconcileClusterRelay,
  syncClusterRelayRoute,
} from "./clusters/relay";
import { savePanelTunnel } from "./instance-settings/panel-tunnel-store";

let db: TestDb;
let pg: PGlite;
let fleet: ReturnType<typeof fakeClusterHosts>;
let origFetch: typeof fetch;
const origIp = process.env.DEPLO_SERVER_IP;

const FP1 = "a".repeat(64);
const FP1_NEW = "b".repeat(64);
const FP2 = "c".repeat(64);
const SUMS =
  `${"a".repeat(64)}  deplo-cluster-linux-amd64\n` +
  `${"b".repeat(64)}  deplo-cluster-linux-arm64\n`;

const TRAEFIK = `services:
  traefik:
    image: traefik:v3.7
    container_name: deplo-traefik
    command:
      - --entrypoints.web.address=:80
      - --entrypoints.websecure.address=:443
      - --certificatesresolvers.letsencrypt.acme.email=ops@acme.com
networks:
  deplo:
    external: true
`;

const ROUTE = {
  domain: "deplo.example.com",
  fallbackDomain: "deplo-cb00710a.deplo.site",
  https: true,
  certResolver: "letsencrypt",
  target: "http://deplo:3000",
};
const STACK = withPanelRoute(TRAEFIK, ROUTE);

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
    truncate table clusters, activities, registration_links, membership_capabilities, memberships, users, teams restart identity cascade;
    delete from instance_settings;`);
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      { id: "user_member", teamId: TEAM_A, role: "member" },
    ],
  });
  await seedServer(db);
  await setFingerprint(SERVER_1, FP1);
  // The seeded server stands for Deplo's own machine; the other one is elsewhere.
  process.env.DEPLO_SERVER_IP = "10.0.0.1";
  await seedServerRow(db, { id: "srv_2", ip: "10.0.0.2", host: "10.0.0.2" });
  await setFingerprint("srv_2", FP2);
  fleet = fakeClusterHosts();
  __setClusterPinForTest({ version: "0.2.0", min: "0.2.0" });
  __resetReleaseCacheForTests();
  origFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(SUMS)) as typeof fetch;
});

afterEach(() => {
  fleet.restore();
  __setClusterPinForTest(null);
  __resetReleaseCacheForTests();
  globalThis.fetch = origFetch;
  if (origIp === undefined) delete process.env.DEPLO_SERVER_IP;
  else process.env.DEPLO_SERVER_IP = origIp;
});

const setFingerprint = (id: string, fp: string) =>
  db
    .update(serversTable)
    .set({ agentCertFingerprint: fp })
    .where(eq(serversTable.id, id));

const asAdmin = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);
const asMember = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: "user_member", teamId: TEAM_A }, fn);

const everyone = { allTeams: true, teamIds: [] };

/** Deplo's machine, running a proxy with the panel's route in it. */
function deploHost(over: Partial<FakeClusterHost> = {}): FakeClusterHost {
  return fleet.host(SERVER_1, {
    proxy: { yaml: STACK, applied: 0, refuse: "" },
    ...over,
  });
}

const rosterCalls = (h: FakeClusterHost) =>
  h.calls
    .filter((c) => c.method === "relay.roster")
    .map((c) => JSON.parse(new TextDecoder().decode(c.payload)));

async function messages(): Promise<string[]> {
  return (await db.select().from(activities)).map((a) => a.message);
}

test("the first cluster starts the relay with the leader on Deplo's machine and puts its route in the proxy", async () => {
  const host = deploHost();
  const cluster = await asAdmin(() => createCluster("eu", everyone));

  assert.equal(host.installs.length, 1);
  assert.equal(host.installs[0].relay, true, "agent 0 runs the relay too");
  const route = panelRoute(host.proxy.yaml);
  assert.equal(route?.relay, true);
  assert.match(host.proxy.yaml, /Path\(`\/api\/cluster\/relay`\)/);
  assert.match(host.proxy.yaml, /host\.docker\.internal:host-gateway/);
  assert.ok(
    (await messages()).includes(
      "Added the cluster relay to the panel's address",
    ),
  );
  assert.deepEqual(rosterCalls(host), [
    {
      cluster: cluster.id,
      parties: [{ fingerprint: FP1, role: "leader" }],
    },
  ]);
});

test("a second cluster changes nothing about the route and sends its own roster", async () => {
  const host = deploHost();
  await asAdmin(() => createCluster("eu", everyone));
  const applied = host.proxy.applied;
  const us = await asAdmin(() => createCluster("us", everyone));
  assert.equal(host.installs.length, 1);
  assert.equal(host.proxy.applied, applied, "the proxy is not rewritten again");
  const last = rosterCalls(host).at(-1);
  assert.equal(last.cluster, us.id);
});

test("the roster names the leader and each member by the certificate their server holds, and skips a server with none", async () => {
  deploHost();
  const m = fleet.host("srv_2");
  await seedServer(db, "srv_3"); // never enrolled: no certificate
  fleet.host("srv_3");
  const c = await asAdmin(() => createCluster("eu", everyone));

  assert.deepEqual(await clusterRoster(c.id, ["srv_2", "srv_3", "srv_2"]), {
    cluster: c.id,
    parties: [
      { fingerprint: FP1, role: "leader" },
      { fingerprint: FP2, role: "member" },
    ],
  });
  const push = await pushClusterRoster(c.id, ["srv_2"]);
  assert.deepEqual(push.dialing, ["srv_2"]);
  assert.deepEqual(m.memberCalls, [{ member: true, relays: [] }]);
});

test("each member is handed its cluster and the certificates that may lead it", async () => {
  deploHost();
  const m = fleet.host("srv_2");
  const c = await asAdmin(() => createCluster("eu", everyone));
  await pushClusterRoster(c.id, ["srv_2"]);
  assert.deepEqual(m.memberPins, [{ clusterId: c.id, leaders: [FP1] }]);
});

test("a member whose agent is too old is named, and the roster still goes out", async () => {
  const host = deploHost();
  fleet.host("srv_2", { capabilities: ["cluster.host"] });
  const c = await asAdmin(() => createCluster("eu", everyone));
  const push = await pushClusterRoster(c.id, ["srv_2"]);
  assert.deepEqual(push.dialing, []);
  assert.equal(push.failed.length, 1);
  assert.equal(push.failed[0].serverId, "srv_2");
  assert.match(push.failed[0].message, /too old to join a cluster/);
  assert.equal(rosterCalls(host).at(-1).parties.length, 2);
});

test("rotating a server's certificate pushes a roster that has only the new one", async () => {
  const host = deploHost();
  const c = await asAdmin(() => createCluster("eu", everyone));
  await setFingerprint(SERVER_1, FP1_NEW);
  await pushRostersForServer(SERVER_1);
  const last = rosterCalls(host).at(-1);
  assert.equal(last.cluster, c.id);
  assert.deepEqual(last.parties, [{ fingerprint: FP1_NEW, role: "leader" }]);
  assert.ok(!JSON.stringify(last).includes(FP1), "the old identity is gone");
});

test("a server that leads nothing pushes nothing when its certificate changes", async () => {
  const host = deploHost();
  await asAdmin(() => createCluster("eu", everyone));
  const before = host.calls.length;
  await pushRostersForServer("srv_2");
  assert.equal(host.calls.length, before);
});

test("the two places a certificate changes both push the rosters", () => {
  for (const file of [
    "../agent/cert-renewal.ts",
    "./servers/agent-handshake.ts",
    "./servers/removal.ts",
  ]) {
    const src = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.match(src, /pushRostersForServer|pushClusterRosters/, file);
  }
});

test("a cluster that is gone gets an empty roster, which makes the relay cut its parties off", async () => {
  const host = deploHost();
  const c = await asAdmin(() => createCluster("eu", everyone));
  await db.delete(clustersTable).where(eq(clustersTable.id, c.id));
  const push = await pushClusterRoster(c.id);
  assert.deepEqual(push.roster, { cluster: c.id, parties: [] });
  assert.deepEqual(rosterCalls(host).at(-1), { cluster: c.id, parties: [] });
});

test("a relay that cannot be reached never undoes the cluster, and the push says why", async () => {
  const host = deploHost();
  const c = await asAdmin(() => createCluster("eu", everyone));
  host.status = { ...host.status, relay: false };
  const push = await pushClusterRoster(c.id);
  assert.equal(push.failed.length, 1);
  assert.match(push.failed[0].message, /No cluster relay is running/);
  assert.equal((await db.select().from(clustersTable)).length, 1);
});

test("a proxy that refuses the route leaves the cluster in place and nothing half-applied", async () => {
  const host = deploHost({
    proxy: { yaml: STACK, applied: 0, refuse: "no" },
  });
  const c = await asAdmin(() => createCluster("eu", everyone));
  assert.equal(panelRoute(host.proxy.yaml)?.relay, undefined);
  assert.equal((await db.select().from(clustersTable)).length, 1);
  assert.equal(c.name, "eu");
  await assert.rejects(syncClusterRelayRoute(), /no/);
});

test("the sweep puts the route back after an update re-rendered the proxy, and sends every roster again", async () => {
  const host = deploHost();
  const a = await asAdmin(() => createCluster("eu", everyone));
  const b = await asAdmin(() => createCluster("us", everyone));
  host.proxy.yaml = STACK; // the installer's update wrote its own file
  const before = rosterCalls(host).length;

  await reconcileClusterRelay();
  assert.equal(panelRoute(host.proxy.yaml)?.relay, true);
  const sent = rosterCalls(host)
    .slice(before)
    .map((r) => r.cluster)
    .sort();
  assert.deepEqual(sent, [a.id, b.id].sort());
});

test("with no cluster left the route and the gateway name leave the proxy", async () => {
  const host = deploHost();
  await asAdmin(() => createCluster("eu", everyone));
  await db.delete(clustersTable);
  assert.equal(await syncClusterRelayRoute(), "off");
  assert.equal(panelRoute(host.proxy.yaml)?.relay, undefined);
  assert.doesNotMatch(host.proxy.yaml, /host-gateway/);
  assert.equal(await syncClusterRelayRoute(), "unchanged");
});

test("behind the panel's Cloudflare Tunnel the relay's path is carried to the host's relay, and undone if the proxy refuses", async () => {
  const { cf, restore } = fakeCloudflare();
  const cloudflareFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    String(input).startsWith("https://api.cloudflare.com")
      ? cloudflareFetch(input, init)
      : Promise.resolve(new Response(SUMS))) as typeof fetch;
  try {
    cf.tunnels.set("tun1", {
      accountId: "acct1",
      name: "deplo",
      ingress: null,
      status: "healthy",
      connections: 1,
    });
    await savePanelTunnel({
      hostname: "deplo.example.com",
      accountId: "acct1",
      zoneId: "zone1",
      tunnelId: "tun1",
      dnsRecordId: null,
      apiTokenEnc: encryptSecret("cf-api-token-0123456789"),
    });
    const host = deploHost({
      proxy: {
        yaml: withPanelTunnel(STACK, "connectortoken0123"),
        applied: 0,
        refuse: "",
      },
    });
    await asAdmin(() => createCluster("eu", everyone));

    const ingress = cf.tunnels.get("tun1")!.ingress as {
      hostname?: string;
      path?: string;
      service: string;
    }[];
    assert.deepEqual(
      ingress.find((r) => r.path === "^/api/cluster/relay$"),
      {
        hostname: "deplo.example.com",
        path: "^/api/cluster/relay$",
        service: "http://host.docker.internal:3002",
      },
    );
    assert.equal(panelTunnelReachesHost(host.proxy.yaml), true);
    assert.equal(panelRoute(host.proxy.yaml)?.relay, true);

    // Turned off again, and the proxy refuses: Cloudflare is put back as it was.
    await db.delete(clustersTable);
    host.proxy.refuse = "refused";
    await assert.rejects(syncClusterRelayRoute(), /refused/);
    const after = cf.tunnels.get("tun1")!.ingress as { path?: string }[];
    assert.ok(
      after.some((r) => r.path === "^/api/cluster/relay$"),
      "the relay rule stays while the route does",
    );
  } finally {
    restore();
  }
});

test("only an instance admin starts a cluster's relay, and nothing reaches the relay for anyone else", async () => {
  const host = deploHost();
  await assert.rejects(
    asMember(() => createCluster("eu", everyone)),
    /instance admin/,
  );
  const c = await asAdmin(() => createCluster("eu", everyone));
  const calls = host.calls.length;
  await assert.rejects(
    asMember(() => ensureClusterLeader(c.id)),
    /instance admin/,
  );
  assert.equal(host.calls.length, calls);
});

test("the relay's route and rosters are part of the Deplo move freeze like every other background job", () => {
  const src = readFileSync(
    new URL("../notify/maintenance.ts", import.meta.url),
    "utf8",
  );
  assert.match(src, /instanceFrozen\(\)\) return;\n[\s\S]*cluster relay/);
});
