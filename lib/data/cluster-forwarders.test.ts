import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { eq, sql } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { runWithIdentity } from "../auth/request-context";
import { seedIdentity, TEAM_A, TEAM_B, USER_1 } from "./identity-test-helpers";
import {
  seedApp,
  seedServer,
  TRUNCATE_PROJECT_GRAPH,
} from "./app-graph-test-helpers";
import { seedDatabase } from "./backup-test-helpers";
import { seedServerRow } from "./infra-test-helpers";
import { apps as appsTable } from "../db/schema/control-plane/apps";
import { databases as databasesTable } from "../db/schema/control-plane/databases";
import {
  clusterNetworkLinks,
  workloadPlacements,
} from "../db/schema/control-plane/clusters";
import { deploMoves } from "../db/schema/control-plane/deplo-move";
import {
  environments as environmentsTable,
  projects as projectsTable,
} from "../db/schema/control-plane/projects";
import { servers as serversTable } from "../db/schema/control-plane/servers";
import { nowIso } from "../ids";
import { __resetReleaseCacheForTests } from "../agent/release";
import { __setClusterPinForTest } from "../infra/agent-client/cluster-host";
import {
  fakeClusterHosts,
  type FakeClusterHost,
} from "../infra/agent-client/cluster-test-helpers";
import { createCluster } from "./clusters/manage";
import { addClusterMember } from "./clusters/members";
import { recordPlacement } from "./clusters/placement";
import {
  planClusterForwarding,
  reconcileNameForwarders,
  syncNameForwarders,
} from "./clusters/forwarders";
import { databaseRelayNotice } from "./clusters/relay-notice";
import {
  CLUSTER_ANSWERS_CAPABILITY,
  CLUSTER_FORWARDERS_SERVICES_CAPABILITY,
} from "../infra/agent-client/hello-capabilities";
import { domains as domainsTable } from "../db/schema/control-plane/domains";
import {
  __forgetAnswerProxies,
  answerAppsRefusal,
  listClusterAnswers,
} from "./clusters/answers";
import {
  clusterMembers as clusterMembersTable,
  clusters as clustersTable,
} from "../db/schema/control-plane/clusters";
import { MAX_ANSWER_SLOT, answerPorts } from "../deploy/answer";
import { activities as activitiesTable } from "../db/schema/control-plane/activity";
import { setClusterAnswerLimits } from "./clusters/manage";
import { syncAnsweringClusters } from "./clusters/forwarders";
import { hasAnswerSupport } from "../deploy/traefik-stack";
import {
  INSTALLED_WITH_PANEL,
  parse,
} from "../deploy/traefik-stack-test-helpers";
import { invalidateFrozen } from "./deplo-move/freeze";

let db: TestDb;
let pg: PGlite;
let fleet: ReturnType<typeof fakeClusterHosts>;
let hosts: Record<string, FakeClusterHost>;
let origFetch: typeof fetch;

const T0 = "2026-01-01T00:00:00.000Z";
const SUMS =
  `${"a".repeat(64)}  deplo-cluster-linux-amd64\n` +
  `${"b".repeat(64)}  deplo-cluster-linux-arm64\n`;
const everyone = { allTeams: true, teamIds: [] as string[] };
const fp = (n: number) => String(n).repeat(64);

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
    truncate table clusters, cluster_network_links, cluster_network_peers, activities, registration_links, membership_capabilities, memberships, users, teams restart identity cascade;`);
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      { id: "user_b", teamId: TEAM_B, role: "owner", isInstanceAdmin: false },
    ],
  });
  await seedServer(db);
  for (const [i, id] of ["srv_2", "srv_3", "srv_4"].entries()) {
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
  for (const [id, team, slug] of [
    ["prc_a", TEAM_A, "shop"],
    ["prc_b", TEAM_B, "blog"],
  ] as const) {
    await db.insert(projectsTable).values({
      id,
      teamId: team,
      name: slug,
      slug,
      position: 0,
      createdAt: T0,
      updatedAt: T0,
    } as never);
  }
  for (const [id, project] of [
    ["environ_a1", "prc_a"],
    ["environ_a2", "prc_a"],
    ["environ_b1", "prc_b"],
  ] as const) {
    await db.insert(environmentsTable).values({
      id,
      projectId: project,
      name: id,
      slug: id,
      kind: "production",
      isDefault: id !== "environ_a2",
      position: 0,
      createdAt: T0,
      updatedAt: T0,
    } as never);
  }
  fleet = fakeClusterHosts();
  hosts = {};
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
  for (const id of ["srv_2", "srv_3", "srv_4"]) hosts[id] = fleet.host(id);
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
const asTeamB = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: "user_b", teamId: TEAM_B }, fn);

async function cluster() {
  const c = await asAdmin(() => createCluster("eu", everyone));
  for (const m of ["srv_2", "srv_3", "srv_4"])
    await asAdmin(() => addClusterMember(c.id, m));
  for (const h of Object.values(hosts)) h.forwarders.length = 0;
  return c;
}

/** An App (git source, no compose: a single-image stack) of a team's Environment, placed on a member. */
async function place(
  clusterId: string,
  id: string,
  environmentId: string,
  member: string,
  teamId = TEAM_A,
  over: Partial<Parameters<typeof seedApp>[1]> = {},
) {
  await seedApp(db, {
    id,
    slug: id,
    teamId,
    serverId: member,
    projectId: teamId === TEAM_A ? "prc_a" : "prc_b",
    environmentId,
    ...over,
  });
  await db.update(appsTable).set({ clusterId }).where(eq(appsTable.id, id));
  await recordPlacement({
    clusterId,
    kind: "app",
    workloadId: id,
    members: [member],
    epoch: 1,
  });
}

async function placeDatabase(
  clusterId: string,
  id: string,
  environmentId: string,
  member: string,
  teamId = TEAM_A,
) {
  await seedDatabase(db, { id, teamId, serverId: member });
  await db
    .update(databasesTable)
    .set({ clusterId, environmentId })
    .where(eq(databasesTable.id, id));
  await recordPlacement({
    clusterId,
    kind: "database",
    workloadId: id,
    members: [member],
    epoch: 1,
  });
}

const last = (id: string) => hosts[id]!.forwarders.at(-1)!;

test("each member is handed its Environments' names that run elsewhere, and never another team's", async () => {
  const c = await cluster();
  await placeDatabase(c.id, "shop", "environ_a1", "srv_2");
  await place(c.id, "web", "environ_a1", "srv_3");
  // team B shares the cluster, and one of its Apps shares a server with team A's database
  await place(c.id, "blog", "environ_b1", "srv_4", TEAM_B);
  await place(c.id, "feed", "environ_b1", "srv_2", TEAM_B);

  await syncNameForwarders(c.id);

  const names = (id: string) =>
    last(id).hold.map((h) => `${h.network}/${h.name}`);
  assert.deepEqual(names("srv_2"), [
    "deplo-env-environ_a1/deplo-web",
    "deplo-env-environ_b1/deplo-blog",
  ]);
  assert.deepEqual(names("srv_3"), ["deplo-env-environ_a1/db-shop"]);
  // team B's other server holds team B's name and nothing of team A's Environment
  assert.deepEqual(names("srv_4"), ["deplo-env-environ_b1/deplo-feed"]);
  assert.equal(last("srv_2").clusterId, c.id);
  assert.deepEqual(
    last("srv_4").members.map((m) => m.serverId),
    ["srv_2", "srv_3", "srv_4"],
  );
  // the workload's id and the engine's port ride with the name
  const held = last("srv_3").hold.find((h) => h.name === "db-shop")!;
  assert.deepEqual(
    [held.kind, held.port, held.workloadId],
    ["database", 5432, "shop"],
  );
});

test("to an agent from before services, a compose stack is handed its Environment's names and offers none", async () => {
  const c = await cluster();
  await placeDatabase(c.id, "shop", "environ_a1", "srv_2");
  await place(c.id, "stack", "environ_a1", "srv_3", TEAM_A, {
    source: "compose",
    repo: null,
    compose: "services:\n  web:\n    image: nginx\n",
  });

  await syncNameForwarders(c.id);

  assert.deepEqual(
    last("srv_3").hold.map((h) => h.name),
    ["db-shop"],
  );
  // The stack's own name is served nowhere; the database's is, to the stack's member.
  for (const id of ["srv_2", "srv_3", "srv_4"])
    assert.deepEqual(
      last(id).serve.map((s) => s.workloadId),
      ["shop"],
      id,
    );
  assert.deepEqual(last("srv_2").hold, []);
  assert.deepEqual(last("srv_2").serve[0]!.sourceFingerprints, [fp(3)]);
});

test("a name is served to the members of its own Environment only, wherever it is served", async () => {
  const c = await cluster();
  await placeDatabase(c.id, "shop", "environ_a1", "srv_2");
  await place(c.id, "web", "environ_a1", "srv_3");
  await place(c.id, "staging", "environ_a2", "srv_3");
  await place(c.id, "blog", "environ_b1", "srv_4", TEAM_B);

  await syncNameForwarders(c.id);

  const served = (id: string) =>
    Object.fromEntries(
      last(id).serve.map((s) => [s.workloadId, s.sourceFingerprints]),
    );
  assert.deepEqual(served("srv_2"), {
    shop: [fp(3)],
    web: [fp(3)],
    staging: [fp(3)],
    blog: [fp(4)],
  });
  assert.deepEqual(served("srv_3"), {
    shop: [fp(2)],
    web: [fp(2)],
    staging: [],
    blog: [fp(4)],
  });
  // another team's member is never let in to team A's names, on any server that may run them
  assert.deepEqual(served("srv_4"), {
    shop: [fp(2), fp(3)],
    web: [fp(2), fp(3)],
    staging: [fp(3)],
    blog: [],
  });
});

test("a failover needs no new table: the server the database lands on already serves it, with no stack render", async () => {
  const c = await cluster();
  await placeDatabase(c.id, "shop", "environ_a1", "srv_2");
  await place(c.id, "web", "environ_a1", "srv_3");
  await syncNameForwarders(c.id);
  // Before anything fails: srv_4 runs nothing of the Environment and is already told who may reach shop on it.
  assert.deepEqual(
    last("srv_4").serve.map((s) => [s.workloadId, s.sourceFingerprints]),
    [
      ["web", [fp(2), fp(3)]],
      ["shop", [fp(2), fp(3)]],
    ],
  );
  assert.deepEqual(last("srv_4").hold, []);

  await recordPlacement({
    clusterId: c.id,
    kind: "database",
    workloadId: "shop",
    members: ["srv_4"],
    epoch: 2,
  });
  await syncNameForwarders(c.id);

  // the App's member still holds the database's name; the server that lost it now runs nothing of the Environment
  assert.deepEqual(
    last("srv_3").hold.map((h) => h.name),
    ["db-shop"],
  );
  assert.deepEqual(last("srv_2").hold, []);
  assert.deepEqual(
    last("srv_4").serve.find((s) => s.workloadId === "shop")!
      .sourceFingerprints,
    [fp(3)],
  );
  assert.equal(hosts.srv_2!.deploys.length, 0);
});

test("another cluster's member is never a source, in the roster, or handed the name", async () => {
  const eu = await asAdmin(() => createCluster("eu", everyone));
  for (const m of ["srv_2", "srv_3"])
    await asAdmin(() => addClusterMember(eu.id, m));
  const us = await asAdmin(() => createCluster("us", everyone));
  await asAdmin(() => addClusterMember(us.id, "srv_4"));
  for (const h of Object.values(hosts)) h.forwarders.length = 0;
  // one Environment, spread over two clusters: its names stay inside each
  await placeDatabase(eu.id, "shop", "environ_a1", "srv_2");
  await place(eu.id, "web", "environ_a1", "srv_3");
  await place(us.id, "far", "environ_a1", "srv_4");

  await syncNameForwarders(eu.id);
  await syncNameForwarders(us.id);

  assert.deepEqual(last("srv_2").serve[0]!.sourceFingerprints, [fp(3)]);
  for (const id of ["srv_2", "srv_3"]) {
    assert.equal(last(id).clusterId, eu.id);
    assert.deepEqual(
      last(id).members.map((m) => m.serverId),
      ["srv_2", "srv_3"],
    );
    assert.ok(!last(id).hold.some((h) => h.name === "deplo-far"));
  }
  assert.equal(last("srv_4").clusterId, us.id);
  assert.deepEqual(last("srv_4").hold, []);
  assert.deepEqual(
    last("srv_4").members.map((m) => m.serverId),
    ["srv_4"],
  );
});

test("a server outside the cluster is never handed a table, whatever a placement says", async () => {
  const c = await cluster();
  await place(c.id, "web", "environ_a1", "srv_2");
  await db.insert(workloadPlacements).values({
    kind: "app",
    workloadId: "web",
    replica: 1,
    memberServerId: "srv_1",
    epoch: 1,
    updatedAt: T0,
  });
  const plan = await planClusterForwarding(c.id);
  assert.deepEqual([...plan.keys()].sort(), ["srv_2", "srv_3", "srv_4"]);
  await syncNameForwarders(c.id);
  assert.deepEqual(hosts.srv_1!.forwarders, []);
});

test("a compose stack's services are held by name on the other server of its Environment, and served from its own", async () => {
  for (const h of Object.values(hosts))
    h.capabilities = [
      ...h.capabilities,
      CLUSTER_FORWARDERS_SERVICES_CAPABILITY,
    ];
  const c = await cluster();
  await placeDatabase(c.id, "shop", "environ_a1", "srv_2");
  await place(c.id, "stack", "environ_a1", "srv_3", TEAM_A, {
    source: "compose",
    repo: null,
    compose:
      'services:\n  web:\n    image: nginx\n  api:\n    image: api\n    hostname: backend\n    expose: ["9000"]\n',
  });

  await syncNameForwarders(c.id);

  assert.deepEqual(
    last("srv_2").hold.map((h) => [h.name, h.service, h.port]),
    [
      ["api", "api", 9000],
      ["backend", "api", 9000],
      ["web", "web", 80],
    ],
  );
  const served = last("srv_3").serve.filter((s) => s.workloadId === "stack");
  assert.deepEqual(
    served.map((s) => [s.service, s.sourceFingerprints]),
    [
      ["api", [fp(2)]],
      ["web", [fp(2)]],
    ],
  );
  // The stack's own member holds none of its names: its containers have them.
  assert.ok(!last("srv_3").hold.some((h) => h.workloadId === "stack"));
});

test("an agent too old to run forwarders is named in the log for a member with work and skipped for one without", async () => {
  const c = await cluster();
  await place(c.id, "web", "environ_a1", "srv_2");
  for (const id of ["srv_2", "srv_3"])
    hosts[id]!.capabilities = hosts[id]!.capabilities.filter(
      (cap) => cap !== "cluster.forwarders",
    );
  const warned: string[] = [];
  const warn = console.warn;
  console.warn = (m: string) => void warned.push(String(m));
  try {
    await syncNameForwarders(c.id);
  } finally {
    console.warn = warn;
  }
  assert.equal(warned.length, 1);
  assert.match(warned[0]!, /srv_2.*too old/);
  assert.equal(hosts.srv_3!.forwarders.length, 0);
  // a member running nothing of the Environment holds none of its names, and is told so
  assert.deepEqual(last("srv_4").hold, []);
});

test("while a Deplo move freezes the instance no table is sent, by a sync or the sweep", async () => {
  const c = await cluster();
  await place(c.id, "web", "environ_a1", "srv_2");
  await db.insert(deploMoves).values({
    id: "dmv_1",
    side: "target",
    state: "copying",
    startedBy: USER_1,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  });
  invalidateFrozen();
  await syncNameForwarders(c.id);
  await reconcileNameForwarders();
  assert.equal(
    Object.values(hosts).reduce((n, h) => n + h.forwarders.length, 0),
    0,
  );
});

test("the sweep hands every cluster its tables", async () => {
  const c = await cluster();
  await place(c.id, "web", "environ_a1", "srv_2");
  await reconcileNameForwarders();
  assert.equal(last("srv_2").serve.length, 1);
});

test("the database page says when Apps reach it through the relay, and only to its own team", async () => {
  const c = await cluster();
  await placeDatabase(c.id, "shop", "environ_a1", "srv_2");
  await place(c.id, "web", "environ_a1", "srv_3");
  await place(c.id, "api", "environ_a1", "srv_2");
  await place(c.id, "other", "environ_a2", "srv_4");
  await place(c.id, "blog", "environ_b1", "srv_4", TEAM_B);

  assert.equal(
    await asAdmin(() => databaseRelayNotice("shop")),
    "web reaches this database through Deplo's relay. It is faster on the same server.",
  );
  assert.equal(await asTeamB(() => databaseRelayNotice("shop")), null);

  // Over the cluster's private network a direct path is no detour, and a relayed one still is (ADR-0047).
  const link = (path: string) =>
    db
      .insert(clusterNetworkLinks)
      .values({
        clusterId: c.id,
        serverId: "srv_3",
        peerServerId: "srv_2",
        path,
        checkedAt: T0,
      })
      .onConflictDoUpdate({
        target: [
          clusterNetworkLinks.clusterId,
          clusterNetworkLinks.serverId,
          clusterNetworkLinks.peerServerId,
        ],
        set: { path },
      });
  await link("direct");
  assert.equal(await asAdmin(() => databaseRelayNotice("shop")), null);
  await link("relay");
  assert.match(
    (await asAdmin(() => databaseRelayNotice("shop"))) ?? "",
    /^web reaches/,
  );

  await recordPlacement({
    clusterId: c.id,
    kind: "app",
    workloadId: "web",
    members: ["srv_2"],
    epoch: 2,
  });
  assert.equal(await asAdmin(() => databaseRelayNotice("shop")), null);
});

test("a database with no Environment counts the team's Apps that have none either", async () => {
  const c = await cluster();
  await seedDatabase(db, { id: "loose", teamId: TEAM_A, serverId: "srv_2" });
  await db
    .update(databasesTable)
    .set({ clusterId: c.id })
    .where(eq(databasesTable.id, "loose"));
  await seedApp(db, { id: "tool", slug: "tool", serverId: "srv_3" });
  await db
    .update(appsTable)
    .set({ clusterId: c.id })
    .where(eq(appsTable.id, "tool"));
  await place(c.id, "web", "environ_a1", "srv_3");

  assert.equal(
    await asAdmin(() => databaseRelayNotice("loose")),
    "tool reaches this database through Deplo's relay. It is faster on the same server.",
  );
});

test("a database outside a cluster has no relay to mention", async () => {
  await seedDatabase(db, { id: "solo" });
  assert.equal(await asAdmin(() => databaseRelayNotice("solo")), null);
});

// ADR-0048: a domain that answers on every server of its cluster.
async function domainOf(
  appId: string,
  name: string,
  over: Partial<typeof domainsTable.$inferInsert> = {},
) {
  await db.insert(domainsTable).values({
    id: `dom_${name}`,
    appId,
    name,
    status: "valid",
    isPrimary: false,
    ssl: true,
    certProvider: "letsencrypt",
    answersEverywhere: true,
    createdAt: T0,
    ...over,
  });
}

/** These members' agents carry answers; every member has Deplo's proxy, so a change would show. */
function proxies(...capable: string[]) {
  __forgetAnswerProxies();
  for (const id of ["srv_2", "srv_3", "srv_4"]) {
    hosts[id]!.proxy.yaml = INSTALLED_WITH_PANEL;
    if (capable.includes(id))
      hosts[id]!.capabilities.push(CLUSTER_ANSWERS_CAPABILITY);
  }
}

test("a cluster with no domain that answers everywhere hands no answer and changes no proxy", async () => {
  const c = await cluster();
  proxies("srv_2", "srv_3", "srv_4");
  await place(c.id, "shop", "environ_a1", "srv_3");
  await domainOf("shop", "shop.example.com", { answersEverywhere: false });

  await syncNameForwarders(c.id);

  for (const id of ["srv_2", "srv_3", "srv_4"]) {
    assert.deepEqual(last(id).answers, [], id);
    assert.equal(hosts[id]!.proxy.applied, 0, id);
    assert.equal(hosts[id]!.proxy.yaml, INSTALLED_WITH_PANEL, id);
  }
});

test("a domain that answers everywhere is passed on by every member, and each proxy changes once", async () => {
  const c = await cluster();
  proxies("srv_2", "srv_3", "srv_4");
  await place(c.id, "shop", "environ_a1", "srv_3");
  await domainOf("shop", "shop.example.com");

  await syncNameForwarders(c.id);

  for (const id of ["srv_2", "srv_3", "srv_4"]) {
    const t = last(id);
    assert.deepEqual(
      t.answers?.map((e) => [e.appId, e.tlsPort, e.webPort]),
      [["shop", 20000, 20001]],
      id,
    );
    const routes = JSON.parse(t.answers![0]!.routes);
    assert.equal(
      routes.tcp.routers["deplo-answer-shop"].rule,
      "HostSNI(`shop.example.com`)",
    );
    assert.deepEqual(t.serveAnswers, ["shop"]);
    assert.equal(t.answerPort, 8443);
    assert.equal(hosts[id]!.proxy.applied, 1, id);
    assert.ok(hasAnswerSupport(hosts[id]!.proxy.yaml), id);
  }
  // Read again, a proxy that has it is not restarted.
  __forgetAnswerProxies();
  await syncNameForwarders(c.id);
  for (const id of ["srv_2", "srv_3", "srv_4"])
    assert.equal(hosts[id]!.proxy.applied, 1, id);
});

test("a member whose agent cannot carry it is handed no answer, and its proxy is left alone", async () => {
  const c = await cluster();
  proxies("srv_2", "srv_3");
  await place(c.id, "shop", "environ_a1", "srv_3");
  await domainOf("shop", "shop.example.com");

  await syncNameForwarders(c.id);

  assert.deepEqual(last("srv_4").answers, []);
  assert.deepEqual(last("srv_4").serveAnswers, []);
  assert.equal(hosts.srv_4!.proxy.applied, 0);
  assert.equal(last("srv_2").answers?.length, 1);
});

test("only an HTTPS domain off the App's tunnel is passed on", async () => {
  const c = await cluster();
  proxies("srv_2", "srv_3", "srv_4");
  await place(c.id, "shop", "environ_a1", "srv_3");
  await domainOf("shop", "plain.example.com", { certProvider: "none" });
  await domainOf("shop", "tunnel.example.com", { tunnel: true });

  await syncNameForwarders(c.id);

  for (const id of ["srv_2", "srv_3", "srv_4"]) {
    assert.deepEqual(last(id).answers, [], id);
    assert.equal(hosts[id]!.proxy.applied, 0, id);
  }
});

test("an App keeps its ports when another one joins", async () => {
  const c = await cluster();
  proxies("srv_2", "srv_3", "srv_4");
  await place(c.id, "shop", "environ_a1", "srv_3");
  await domainOf("shop", "shop.example.com");
  await syncNameForwarders(c.id);
  // An App whose id sorts first comes later: the one already passed on keeps its ports.
  await place(c.id, "aaa", "environ_a1", "srv_2");
  await domainOf("aaa", "aaa.example.com");
  await syncNameForwarders(c.id);

  assert.deepEqual(
    last("srv_4").answers?.map((e) => [e.appId, e.tlsPort]),
    [
      ["shop", 20000],
      ["aaa", 20002],
    ],
  );
});

test("turning the last one off takes the change out of every proxy, as it was", async () => {
  const c = await cluster();
  proxies("srv_2", "srv_3", "srv_4");
  await place(c.id, "shop", "environ_a1", "srv_3");
  await domainOf("shop", "shop.example.com");
  await syncNameForwarders(c.id);
  await db
    .update(domainsTable)
    .set({ answersEverywhere: false })
    .where(eq(domainsTable.appId, "shop"));

  await syncNameForwarders(c.id);

  for (const id of ["srv_2", "srv_3", "srv_4"]) {
    assert.deepEqual(last(id).answers, [], id);
    assert.equal(hosts[id]!.proxy.applied, 2, id);
    assert.deepEqual(
      parse(hosts[id]!.proxy.yaml),
      parse(INSTALLED_WITH_PANEL),
      id,
    );
  }
});

const tlsPorts = (id: string) =>
  last(id).answers?.map((e) => [e.appId, e.tlsPort]);

// A visitor of an App that just stopped answering everywhere must never reach the one that just started.
test("a slot an App let go is never handed to the next one", async () => {
  const c = await cluster();
  proxies("srv_2", "srv_3", "srv_4");
  await place(c.id, "shop", "environ_a1", "srv_3");
  await domainOf("shop", "shop.example.com");
  await syncNameForwarders(c.id);
  await db
    .update(domainsTable)
    .set({ answersEverywhere: false })
    .where(eq(domainsTable.appId, "shop"));
  await place(c.id, "blog", "environ_a1", "srv_2");
  await domainOf("blog", "blog.example.com");
  await syncNameForwarders(c.id);
  assert.deepEqual(tlsPorts("srv_4"), [["blog", 20002]]);

  // Nor the slot of an App that is gone.
  await db.delete(appsTable).where(eq(appsTable.id, "blog"));
  await place(c.id, "wiki", "environ_a1", "srv_2");
  await domainOf("wiki", "wiki.example.com");
  await syncNameForwarders(c.id);
  assert.deepEqual(tlsPorts("srv_4"), [["wiki", 20004]]);

  // An App turned on again gets its own slot back.
  await db
    .update(domainsTable)
    .set({ answersEverywhere: true })
    .where(eq(domainsTable.appId, "shop"));
  await syncNameForwarders(c.id);
  assert.deepEqual(tlsPorts("srv_4"), [
    ["shop", 20000],
    ["wiki", 20004],
  ]);
});

test("slots start again from the lowest free one only once they run out", async () => {
  const c = await cluster();
  proxies("srv_2", "srv_3", "srv_4");
  await db
    .update(clustersTable)
    .set({ answerSlotNext: MAX_ANSWER_SLOT })
    .where(eq(clustersTable.id, c.id));
  await place(c.id, "shop", "environ_a1", "srv_3");
  await domainOf("shop", "shop.example.com");
  await syncNameForwarders(c.id);
  await place(c.id, "blog", "environ_a1", "srv_2");
  await domainOf("blog", "blog.example.com");
  await syncNameForwarders(c.id);

  assert.deepEqual(tlsPorts("srv_4"), [
    ["blog", 20000],
    ["shop", answerPorts(MAX_ANSWER_SLOT).tls],
  ]);
});

// A server agent refuses a whole table past its limit: the Apps past it wait, the others keep answering.
test("past the limit one more App is refused, and the table never carries more", async () => {
  const c = await cluster();
  for (const [id, name] of [
    ["shop", "shop.example.com"],
    ["blog", "blog.example.com"],
    ["wiki", "wiki.example.com"],
  ] as const) {
    await place(c.id, id, "environ_a1", "srv_3");
    await domainOf(id, name, { answersEverywhere: id !== "wiki" });
  }

  assert.match(
    (await answerAppsRefusal(c.id, "wiki", 2)) ?? "",
    /already has 2 Apps that answer on every server/,
  );
  assert.equal(await answerAppsRefusal(c.id, "shop", 2), null);
  assert.equal(await answerAppsRefusal(c.id, "wiki", 3), null);

  await db
    .update(domainsTable)
    .set({ answersEverywhere: true })
    .where(eq(domainsTable.appId, "wiki"));
  const first = await listClusterAnswers(c.id, 2);
  assert.deepEqual(
    first.map((a) => a.appId),
    ["blog", "shop"],
  );
});

test("each server is handed the cluster's connection limits, which only an admin sets, within range", async () => {
  const c = await cluster();
  proxies("srv_2", "srv_3", "srv_4");
  await place(c.id, "shop", "environ_a1", "srv_3");
  await domainOf("shop", "shop.example.com");
  await syncNameForwarders(c.id);
  assert.deepEqual(
    [last("srv_2").answerMaxConns, last("srv_2").answerMaxWaiting],
    [2048, 128],
  );

  await assert.rejects(
    asAdmin(() => setClusterAnswerLimits(c.id, 32, 8)),
    /between 64 and 65536 connections/,
  );
  await assert.rejects(
    asAdmin(() => setClusterAnswerLimits(c.id, 4096, 2000)),
    /Between 1 and 1024 visitors can wait/,
  );
  await assert.rejects(asTeamB(() => setClusterAnswerLimits(c.id, 8192, 256)));
  const set = await asAdmin(() => setClusterAnswerLimits(c.id, 8192, 512));
  assert.deepEqual(
    [set.answerMaxConnections, set.answerMaxWaiting],
    [8192, 512],
  );
  await syncNameForwarders(c.id);
  for (const id of ["srv_2", "srv_3", "srv_4"])
    assert.deepEqual(
      [last(id).answerMaxConns, last(id).answerMaxWaiting],
      [8192, 512],
      id,
    );
});

test("what a server turned away reaches Activity: an App's wait to its team, the server's cap to the cluster's", async () => {
  const c = await cluster();
  proxies("srv_2", "srv_3", "srv_4");
  await place(c.id, "shop", "environ_a1", "srv_3");
  await domainOf("shop", "shop.example.com");
  const at = Date.parse("2026-11-16T14:02:00.000Z");
  hosts.srv_2!.answerRefusals = [
    {
      appId: "",
      count: 37,
      firstUnixMs: at,
      lastUnixMs: at + 180_000,
      cap: 2048,
    },
    {
      appId: "shop",
      count: 12,
      firstUnixMs: at,
      lastUnixMs: at + 60_000,
      cap: 128,
    },
  ];

  await syncNameForwarders(c.id);

  const rows = await db
    .select({
      message: activitiesTable.message,
      teamId: activitiesTable.teamId,
      appId: activitiesTable.appId,
    })
    .from(activitiesTable);
  const server = rows.find((r) =>
    r.message.includes("to domains that answer on every server"),
  );
  assert.match(
    server?.message ?? "",
    /turned away 37 visitor connections .* between 14:02 and 14:05 UTC: it carries at most 2048 at once/,
  );
  assert.equal(server?.teamId, TEAM_A);
  const app = rows.find((r) => r.appId === "shop");
  assert.match(
    app?.message ?? "",
    /turned away 12 visitor connections to shop .*at most 128 visitors wait for it at once/,
  );
  assert.equal(app?.teamId, TEAM_A);
  // Reported once: the agent forgot them with that table.
  await syncNameForwarders(c.id);
  const again = await db
    .select({ id: activitiesTable.id })
    .from(activitiesTable);
  assert.equal(again.length, rows.length);
});

test("every 2 minutes only the clusters that pass domains on are asked", async () => {
  const c = await cluster();
  proxies("srv_2", "srv_3", "srv_4");
  await place(c.id, "shop", "environ_a1", "srv_3");
  await domainOf("shop", "shop.example.com", { answersEverywhere: false });
  await syncAnsweringClusters();
  assert.equal(hosts.srv_2!.forwarders.length, 0);

  await db
    .update(domainsTable)
    .set({ answersEverywhere: true })
    .where(eq(domainsTable.appId, "shop"));
  await syncAnsweringClusters();
  assert.equal(hosts.srv_2!.forwarders.length, 1);
});

test("the smallest server's memory bounds the cap, and the cost is said in Activity", async () => {
  const c = await cluster();
  await db
    .update(serversTable)
    .set({ memoryMb: 512 })
    .where(eq(serversTable.id, "srv_3"));
  await assert.rejects(
    asAdmin(() => setClusterAnswerLimits(c.id, 4096, 128)),
    /has 512 MB of memory: at most 2048 connections fit in a quarter of it, at up to 64 KB each/,
  );
  await asAdmin(() => setClusterAnswerLimits(c.id, 2048, 256));
  const [entry] = await db
    .select({ message: activitiesTable.message })
    .from(activitiesTable)
    .where(
      sql`${activitiesTable.message} like '%visitor connections at once%'`,
    );
  assert.match(
    entry?.message ?? "",
    /up to 2048 visitor connections at once .*\(up to 128 MB of its memory\)/,
  );
});

// Decided from each proxy, not from what Deplo remembers: each way a cluster stops needing the change.
async function answeringCluster() {
  const c = await cluster();
  proxies("srv_2", "srv_3", "srv_4");
  await place(c.id, "shop", "environ_a1", "srv_3");
  await domainOf("shop", "shop.example.com");
  await syncAnsweringClusters();
  for (const id of ["srv_2", "srv_3", "srv_4"])
    assert.ok(hasAnswerSupport(hosts[id]!.proxy.yaml), id);
  return c;
}

const putBack = (...ids: string[]) => {
  for (const id of ids) {
    assert.ok(
      !hasAnswerSupport(hosts[id]!.proxy.yaml),
      `${id} kept the change`,
    );
    assert.deepEqual(
      parse(hosts[id]!.proxy.yaml),
      parse(INSTALLED_WITH_PANEL),
      id,
    );
  }
};

test("the last domain gone, even across a restart of Deplo, every proxy loses the change", async () => {
  await answeringCluster();
  // A restart between two passes: Deplo remembers nothing of the proxies.
  __forgetAnswerProxies();
  await db.delete(domainsTable).where(eq(domainsTable.appId, "shop"));
  await syncAnsweringClusters();
  for (const id of ["srv_2", "srv_3", "srv_4"])
    assert.deepEqual(last(id).answers, [], id);
  putBack("srv_2", "srv_3", "srv_4");
  // Then it is left alone.
  const tables = hosts.srv_2!.forwarders.length;
  await syncAnsweringClusters();
  assert.equal(hosts.srv_2!.forwarders.length, tables);
});

test("a cluster deleted while its servers kept the change: each server loses it alone", async () => {
  const c = await answeringCluster();
  __forgetAnswerProxies();
  await db.delete(clustersTable).where(eq(clustersTable.id, c.id));
  await syncAnsweringClusters();
  putBack("srv_2", "srv_3", "srv_4");
});

test("a server taken out of the cluster loses the change, and the others keep it", async () => {
  await answeringCluster();
  await db
    .delete(clusterMembersTable)
    .where(eq(clusterMembersTable.serverId, "srv_2"));
  await syncAnsweringClusters();
  putBack("srv_2");
  for (const id of ["srv_3", "srv_4"])
    assert.ok(hasAnswerSupport(hosts[id]!.proxy.yaml), id);
});

test("an App moved out of the cluster takes the change off its servers with it", async () => {
  await answeringCluster();
  await db
    .update(appsTable)
    .set({ clusterId: null })
    .where(eq(appsTable.id, "shop"));
  await syncAnsweringClusters();
  for (const id of ["srv_2", "srv_3", "srv_4"])
    assert.deepEqual(last(id).answers, [], id);
  putBack("srv_2", "srv_3", "srv_4");
});
