import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { runWithIdentity } from "../auth/request-context";
import { activities } from "../db/schema/control-plane/activity";
import { apps as appsTable } from "../db/schema/control-plane/apps";
import {
  dnsProviderTunnels,
  domainDnsRecords,
} from "../db/schema/control-plane/dns-providers";
import {
  fakeCloudflare,
  type FakeCloudflare,
} from "../cloudflare/cloudflare-test-helpers";
import {
  fakeClusterHosts,
  type FakeClusterHost,
} from "../infra/agent-client/cluster-test-helpers";
import {
  appTunnelService,
  hasTunnelConnector,
} from "../deploy/panel-tunnel-stack";
import {
  seedIdentity,
  TEAM_A,
  TRUNCATE_IDENTITY,
} from "./identity-test-helpers";
import {
  seedApp,
  seedServer,
  SERVER_1,
  TRUNCATE_PROJECT_GRAPH,
} from "./app-graph-test-helpers";
import { seedServerRow } from "./infra-test-helpers";
import {
  __setDnsResolve4ForTest,
  __resetDnsResolve4ForTest,
} from "./domains/dns-check";
import { addDomain } from "./domains/crud";
import { saveDnsProvider } from "./dns-providers/store";
import {
  followAppServer,
  reconcileTunnelDomains,
} from "./dns-providers/follow";
import { invalidateFrozen } from "./deplo-move/freeze";
import { turnOnExperiments } from "./experiments-test-helpers";

let db: TestDb;
let pg: PGlite;
let cf: FakeCloudflare;
let restoreCf = () => {};
let fleet: ReturnType<typeof fakeClusterHosts>;
let hosts: Record<string, FakeClusterHost> = {};

const OWNER = "owner1";
const HOST = "deplo.example.com";
const PROXY = "http://deplo-traefik:80";
const STACK = `services:
  traefik:
    image: traefik:v3.7
    container_name: deplo-traefik
networks:
  deplo:
    external: true
`;

const as = <T>(fn: () => Promise<T>) =>
  runWithIdentity({ userId: OWNER, teamId: TEAM_A }, fn);

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
  __setDnsResolve4ForTest(async () => []);
});

after(async () => {
  __resetTestDb();
  __resetDnsResolve4ForTest();
  await pg.close();
});

beforeEach(async () => {
  await pg.exec(TRUNCATE_PROJECT_GRAPH);
  await pg.exec(TRUNCATE_IDENTITY);
  await pg.exec(
    "truncate table dns_providers, activities restart identity cascade;",
  );
  await seedIdentity(db, {
    users: [{ id: OWNER, teamId: TEAM_A, role: "owner" }],
  });
  await turnOnExperiments(db, "tunnels");
  await seedServer(db);
  await seedServerRow(db, {
    id: "srv_2",
    name: "eu-2",
    ip: "10.0.0.2",
    host: "10.0.0.2",
  });
  await seedApp(db, { id: "prj_web" });
  await seedApp(db, { id: "prj_docs" });
  fleet = fakeClusterHosts();
  hosts = {};
  for (const id of [SERVER_1, "srv_2"])
    hosts[id] = fleet.host(id, {
      proxy: { yaml: STACK, applied: 0, refuse: "" },
    });
  ({ cf, restore: restoreCf } = fakeCloudflare());
  invalidateFrozen();
});

afterEach(() => {
  restoreCf();
  fleet.restore();
  invalidateFrozen();
});

const connect = () =>
  as(() =>
    saveDnsProvider({
      provider: "cloudflare",
      zone: "example.com",
      apiToken: "cf-token-0123456789",
      teamIds: [TEAM_A],
      shared: false,
    }),
  );

const tunnelOn = async (serverId: string) =>
  (
    await db
      .select()
      .from(dnsProviderTunnels)
      .where(eq(dnsProviderTunnels.serverId, serverId))
  )[0]!;

const routed = (tunnelId: string) =>
  ((cf.tunnels.get(tunnelId)?.ingress ?? []) as { hostname?: string }[]).map(
    (r) => r.hostname,
  );

const records = () =>
  [...cf.records.values()]
    .filter((r) => r.name === HOST)
    .map((r) => ({ type: r.type, content: r.content }));

const runsOn = (appId: string, serverId: string) =>
  db.update(appsTable).set({ serverId }).where(eq(appsTable.id, appId));

const activity = async (appId: string) =>
  (await db.select().from(activities).where(eq(activities.appId, appId))).map(
    (a) => a.message,
  );

test("a tunnel domain follows its App to the server it runs on now, the connector started there first", async () => {
  const saved = await connect();
  await as(() => addDomain("prj_web", HOST, { tunnel: true }));
  const first = await tunnelOn(SERVER_1);
  await runsOn("prj_web", "srv_2");

  assert.deepEqual(await followAppServer("prj_web"), {
    moved: [HOST],
    problems: [],
  });
  const second = await tunnelOn("srv_2");
  assert.ok(
    hasTunnelConnector(hosts.srv_2.proxy.yaml, appTunnelService(saved.id)),
  );
  assert.deepEqual(records(), [
    { type: "CNAME", content: `${second.tunnelId}.cfargotunnel.com` },
  ]);
  // The tunnel hands the hostname to that server's proxy by its name, never by an address.
  assert.deepEqual(cf.tunnels.get(second.tunnelId)?.ingress, [
    { hostname: HOST, service: PROXY },
    { service: "http_status:404" },
  ]);
  assert.deepEqual(routed(first.tunnelId), [undefined]);
  const [row] = await db.select().from(domainDnsRecords);
  assert.equal(row.tunnelId, second.id);
  assert.ok(
    (await activity("prj_web")).includes(
      `Moved ${HOST} to the Cloudflare Tunnel on eu-2, where prj_web runs now`,
    ),
  );

  const calls = cf.calls.length;
  assert.deepEqual(await followAppServer("prj_web"), {
    moved: [],
    problems: [],
  });
  assert.equal(cf.calls.length, calls, "nothing to do the second time");
});

test("a path another App serves on the hostname rides on its record and moves with it", async () => {
  await connect();
  await as(() => addDomain("prj_web", HOST, { tunnel: true }));
  const made = cf.records.size;
  const docs = await as(() =>
    addDomain("prj_docs", HOST, { pathPrefix: "/docs" }),
  );
  assert.equal(docs.tunnel, true, "served the way the hostname is");
  assert.equal(cf.records.size, made, "no record of its own");
  const first = await tunnelOn(SERVER_1);
  await runsOn("prj_web", "srv_2");
  await runsOn("prj_docs", "srv_2");

  assert.deepEqual(
    await followAppServer("prj_docs"),
    { moved: [], problems: [] },
    "the path follows the App on the whole host",
  );
  assert.deepEqual(await followAppServer("prj_web"), {
    moved: [HOST],
    problems: [],
  });
  const second = await tunnelOn("srv_2");
  const rows = await db.select().from(domainDnsRecords);
  assert.deepEqual(
    rows.map((r) => r.tunnelId),
    [second.id, second.id],
  );
  assert.equal(new Set(rows.map((r) => r.recordId)).size, 1);
  assert.deepEqual(routed(first.tunnelId), [undefined]);
});

test("a hostname waits for the connector on the new server before it moves", async () => {
  await connect();
  await as(() => addDomain("prj_web", HOST, { tunnel: true }));
  const first = await tunnelOn(SERVER_1);
  await runsOn("prj_web", "srv_2");

  cf.connectedStatus = "inactive";
  assert.deepEqual(await followAppServer("prj_web"), {
    moved: [],
    problems: [],
  });
  assert.deepEqual(records(), [
    { type: "CNAME", content: `${first.tunnelId}.cfargotunnel.com` },
  ]);
  const second = await tunnelOn("srv_2");
  assert.deepEqual(routed(second.tunnelId), [undefined]);

  cf.connectedStatus = "healthy";
  await reconcileTunnelDomains();
  assert.deepEqual(records(), [
    { type: "CNAME", content: `${second.tunnelId}.cfargotunnel.com` },
  ]);
});

test("a route changed by hand in Cloudflare is put back, naming the proxy and never an address", async () => {
  await connect();
  await as(() => addDomain("prj_web", HOST, { tunnel: true }));
  const t = await tunnelOn(SERVER_1);
  const wanted = cf.tunnels.get(t.tunnelId)!.ingress;
  cf.tunnels.get(t.tunnelId)!.ingress = [
    { hostname: HOST, service: "http://203.0.113.7:80" },
    { service: "http_status:404" },
  ];

  await reconcileTunnelDomains();
  assert.deepEqual(cf.tunnels.get(t.tunnelId)!.ingress, wanted);
  const calls = cf.calls.length;
  await reconcileTunnelDomains();
  assert.equal(
    cf.calls.slice(calls).filter((c) => !c.startsWith("GET")).length,
    0,
    "a tunnel that routes right is left alone",
  );
});
