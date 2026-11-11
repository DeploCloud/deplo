import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

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
import { workloadPlacements } from "../db/schema/control-plane/clusters";
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
    truncate table clusters, activities, registration_links, membership_capabilities, memberships, users, teams restart identity cascade;`);
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

test("a compose stack on another member is handed its Environment's names and offers none", async () => {
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
