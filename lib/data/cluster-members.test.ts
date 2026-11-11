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
  SERVER_1,
  TRUNCATE_PROJECT_GRAPH,
} from "./app-graph-test-helpers";
import { seedDatabase } from "./backup-test-helpers";
import { seedServerRow } from "./infra-test-helpers";
import { activities } from "../db/schema/control-plane/activity";
import { apps as appsTable } from "../db/schema/control-plane/apps";
import {
  clusterMembers,
  workloadPlacements,
} from "../db/schema/control-plane/clusters";
import { databases as databasesTable } from "../db/schema/control-plane/databases";
import { servers as serversTable } from "../db/schema/control-plane/servers";
import { __resetReleaseCacheForTests } from "../agent/release";
import { __setClusterPinForTest } from "../infra/agent-client/cluster-host";
import { CLUSTER_HOST_CAPABILITY } from "../infra/agent-client/hello-capabilities";
import { fakeClusterHosts } from "../infra/agent-client/cluster-test-helpers";
import { createCluster } from "./clusters/manage";
import {
  addClusterMember,
  assertServerNotInCluster,
  ClusterJoinRefusedError,
  listClusterJoinCandidates,
  listClusterMembers,
} from "./clusters/members";
import {
  clustersOfServer,
  pushClusterRoster,
  pushClusterRosters,
} from "./clusters/relay";
import { placementEntries } from "./clusters/leader-sync";
import { getCluster } from "./clusters/roster";
import { listServerChoices } from "./servers/roster";
import { createApp } from "./apps/create";
import { failoverOn } from "../types/cluster";

let db: TestDb;
let pg: PGlite;
let fleet: ReturnType<typeof fakeClusterHosts>;
let origFetch: typeof fetch;
const origIp = process.env.DEPLO_SERVER_IP;

const FP1 = "a".repeat(64);
const FP2 = "c".repeat(64);
const FP3 = "d".repeat(64);
const SUMS =
  `${"a".repeat(64)}  deplo-cluster-linux-amd64\n` +
  `${"b".repeat(64)}  deplo-cluster-linux-arm64\n`;
const COMPOSE =
  'services:\n  web:\n    image: nginx:1.27\n    expose:\n      - "80"\n';

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
});

after(async () => {
  __resetTestDb();
  await pg.close();
});

async function fingerprint(id: string, fp: string) {
  await db
    .update(serversTable)
    .set({ agentCertFingerprint: fp })
    .where(eq(serversTable.id, id));
}

beforeEach(async () => {
  await pg.exec(`${TRUNCATE_PROJECT_GRAPH}
    truncate table clusters, activities, registration_links, membership_capabilities, memberships, users, teams restart identity cascade;`);
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      { id: "user_b", teamId: TEAM_B, role: "owner", isInstanceAdmin: false },
      {
        id: "user_member",
        teamId: TEAM_A,
        role: "member",
        capabilities: ["view", "create_apps", "deploy_apps"],
      },
    ],
  });
  await seedServer(db);
  await fingerprint(SERVER_1, FP1);
  // The seeded server stands for Deplo's own machine; srv_2 and srv_3 are elsewhere.
  process.env.DEPLO_SERVER_IP = "10.0.0.1";
  await seedServerRow(db, { id: "srv_2", ip: "10.0.0.2", host: "10.0.0.2" });
  await seedServerRow(db, { id: "srv_3", ip: "10.0.0.3", host: "10.0.0.3" });
  await fingerprint("srv_2", FP2);
  await fingerprint("srv_3", FP3);
  fleet = fakeClusterHosts();
  fleet.host(SERVER_1);
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

const asAdmin = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);
const asMember = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: "user_member", teamId: TEAM_A }, fn);
const asTeamB = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: "user_b", teamId: TEAM_B }, fn);

const everyone = { allTeams: true, teamIds: [] };

async function messages(): Promise<string[]> {
  return (await db.select().from(activities)).map((a) => a.message);
}

async function refusal(p: Promise<unknown>): Promise<string[]> {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof ClusterJoinRefusedError, String(e));
    return e.reasons.map((r) => r.code);
  }
  assert.fail("the join was not refused");
}

test("joining brings the Apps and databases along where they run, with nothing redeployed", async () => {
  fleet.host("srv_2");
  await seedApp(db, { id: "web", serverId: "srv_2" });
  await seedDatabase(db, { id: "db_1", serverId: "srv_2" });
  await seedApp(db, { id: "elsewhere", serverId: "srv_3" });
  const cluster = await asAdmin(() => createCluster("eu", everyone));

  const joined = await asAdmin(() => addClusterMember(cluster.id, "srv_2"));
  assert.equal(joined.apps, 1);
  assert.equal(joined.databases, 1);
  assert.equal(joined.member.serverId, "srv_2");

  const [web] = await db
    .select()
    .from(appsTable)
    .where(eq(appsTable.id, "web"));
  assert.equal(web.clusterId, cluster.id);
  assert.equal(web.serverId, "srv_2");
  const [other] = await db
    .select()
    .from(appsTable)
    .where(eq(appsTable.id, "elsewhere"));
  assert.equal(other.clusterId, null);
  const [pgdb] = await db
    .select()
    .from(databasesTable)
    .where(eq(databasesTable.id, "db_1"));
  assert.equal(pgdb.clusterId, cluster.id);
  assert.equal(pgdb.serverId, "srv_2");
  // No deploy, no stack change: the member's agent was only asked to start dialing.
  assert.deepEqual(fleet.host("srv_2").calls, []);
  assert.equal(fleet.host("srv_2").installs.length, 0);
});

test("joining records where each App and database runs, so the leader fences and fails them over", async () => {
  fleet.host("srv_2");
  await seedApp(db, { id: "web", serverId: "srv_2" });
  await seedApp(db, { id: "twice", slug: "twice", serverId: "srv_2" });
  await db
    .update(appsTable)
    .set({ replicas: 2 })
    .where(eq(appsTable.id, "twice"));
  await seedDatabase(db, { id: "db_1", serverId: "srv_2" });
  await seedApp(db, { id: "elsewhere", serverId: "srv_3" });
  const cluster = await asAdmin(() => createCluster("eu", everyone));
  await asAdmin(() => addClusterMember(cluster.id, "srv_2"));

  const rows = (await db.select().from(workloadPlacements))
    .map((r) => `${r.kind}/${r.workloadId}/${r.replica}@${r.memberServerId}`)
    .sort();
  assert.deepEqual(rows, [
    "app/twice/0@srv_2",
    "app/twice/1@srv_2",
    "app/web/0@srv_2",
    "database/db_1/0@srv_2",
  ]);
  const told = (await placementEntries(cluster.id)).map(
    (e) =>
      `${e.kind}/${e.id}/${e.replica}@${e.member}${e.singleWriter ? " single-writer" : ""}`,
  );
  assert.deepEqual(told, [
    "app/twice/0@srv_2",
    "app/twice/1@srv_2",
    "app/web/0@srv_2",
    "database/db_1/0@srv_2 single-writer",
  ]);
});

test("joining records Activity and pushes the roster with the new member", async () => {
  const relay = fleet.host(SERVER_1);
  const member = fleet.host("srv_2");
  const cluster = await asAdmin(() => createCluster("eu", everyone));
  relay.calls.length = 0;
  await asAdmin(() => addClusterMember(cluster.id, "srv_2"));

  assert.ok(
    (await messages()).some((m) => /Added server srv_2 to cluster eu$/.test(m)),
  );
  const roster = relay.calls.filter((c) => c.method === "relay.roster").at(-1)!;
  const body = JSON.parse(new TextDecoder().decode(roster.payload));
  assert.deepEqual(body.parties, [
    { fingerprint: FP1, role: "leader" },
    { fingerprint: FP2, role: "member" },
  ]);
  assert.deepEqual(member.memberCalls.at(-1)?.member, true);
});

test("a roster push reads the members from the table, and a removed server leaves it", async () => {
  const relay = fleet.host(SERVER_1);
  fleet.host("srv_2");
  const cluster = await asAdmin(() => createCluster("eu", everyone));
  await asAdmin(() => addClusterMember(cluster.id, "srv_2"));
  assert.deepEqual(await clustersOfServer("srv_2"), [cluster.id]);
  const push = await pushClusterRoster(cluster.id);
  assert.deepEqual(push.dialing, ["srv_2"]);

  relay.calls.length = 0;
  // What removeServer does: collect the clusters, delete the row (the membership goes with it), push.
  const clusterIds = await clustersOfServer("srv_2");
  await db.delete(serversTable).where(eq(serversTable.id, "srv_2"));
  await pushClusterRosters(clusterIds);
  const roster = relay.calls.filter((c) => c.method === "relay.roster").at(-1)!;
  const body = JSON.parse(new TextDecoder().decode(roster.payload));
  assert.deepEqual(body.parties, [{ fingerprint: FP1, role: "leader" }]);
  assert.equal((await db.select().from(clusterMembers)).length, 0);
});

test("a join is refused when the server is offline", async () => {
  const cluster = await asAdmin(() => createCluster("eu", everyone));
  // srv_2 answers nothing at all.
  assert.deepEqual(
    await refusal(asAdmin(() => addClusterMember(cluster.id, "srv_2"))),
    ["offline"],
  );
  // A server Deplo already knows is offline is refused without dialing it.
  await db
    .update(serversTable)
    .set({ status: "offline" })
    .where(eq(serversTable.id, "srv_3"));
  const h = fleet.host("srv_3");
  assert.deepEqual(
    await refusal(asAdmin(() => addClusterMember(cluster.id, "srv_3"))),
    ["offline"],
  );
  assert.equal(h.opened.length, 0);
  assert.equal((await db.select().from(clusterMembers)).length, 0);
});

test("a join is refused when the server agent is too old", async () => {
  fleet.host("srv_2", { capabilities: [CLUSTER_HOST_CAPABILITY, "hostops"] });
  const cluster = await asAdmin(() => createCluster("eu", everyone));
  assert.deepEqual(
    await refusal(asAdmin(() => addClusterMember(cluster.id, "srv_2"))),
    ["agent_too_old"],
  );
  await assert.rejects(
    () => asAdmin(() => addClusterMember(cluster.id, "srv_2")),
    /The server agent on srv_2 is too old to join a cluster\. Deplo updates it on its own\./,
  );
});

test("a join is refused when the server is already in a cluster", async () => {
  fleet.host("srv_2");
  const eu = await asAdmin(() => createCluster("eu", everyone));
  const us = await asAdmin(() => createCluster("us", everyone));
  await asAdmin(() => addClusterMember(eu.id, "srv_2"));
  assert.deepEqual(
    await refusal(asAdmin(() => addClusterMember(us.id, "srv_2"))),
    ["in_cluster"],
  );
  assert.deepEqual(
    await refusal(asAdmin(() => addClusterMember(eu.id, "srv_2"))),
    ["in_cluster"],
  );
  await assert.rejects(
    () => asAdmin(() => addClusterMember(us.id, "srv_2")),
    /already in cluster eu/,
  );
});

test("a join is refused for a storage-only server", async () => {
  await db
    .update(serversTable)
    .set({ storageOnly: true })
    .where(eq(serversTable.id, "srv_2"));
  fleet.host("srv_2");
  const cluster = await asAdmin(() => createCluster("eu", everyone));
  assert.deepEqual(
    await refusal(asAdmin(() => addClusterMember(cluster.id, "srv_2"))),
    ["cannot_host"],
  );
});

test("a join is refused when it runs Apps of a team the cluster isn't shared with", async () => {
  fleet.host("srv_2");
  await seedApp(db, { id: "theirs", teamId: TEAM_B, serverId: "srv_2" });
  const cluster = await asAdmin(() =>
    createCluster("private", { allTeams: false, teamIds: [TEAM_A] }),
  );
  assert.deepEqual(
    await refusal(asAdmin(() => addClusterMember(cluster.id, "srv_2"))),
    ["other_teams"],
  );
  const [row] = await db
    .select()
    .from(appsTable)
    .where(eq(appsTable.id, "theirs"));
  assert.equal(row.clusterId, null);
  assert.equal((await db.select().from(clusterMembers)).length, 0);

  // Sharing the cluster with that team lifts the refusal, and a database counts as much as an App.
  await seedDatabase(db, { id: "db_b", teamId: TEAM_B, serverId: "srv_3" });
  fleet.host("srv_3");
  assert.deepEqual(
    await refusal(asAdmin(() => addClusterMember(cluster.id, "srv_3"))),
    ["other_teams"],
  );
});

test("every reason is listed at once so the admin fixes them in one pass", async () => {
  await db
    .update(serversTable)
    .set({ storageOnly: true, status: "offline" })
    .where(eq(serversTable.id, "srv_2"));
  await seedApp(db, { id: "theirs", teamId: TEAM_B, serverId: "srv_2" });
  const cluster = await asAdmin(() =>
    createCluster("private", { allTeams: false, teamIds: [TEAM_A] }),
  );
  const codes = await refusal(
    asAdmin(() => addClusterMember(cluster.id, "srv_2")),
  );
  assert.deepEqual(codes.sort(), ["cannot_host", "offline", "other_teams"]);
});

test("the join picker says what blocks each server", async () => {
  fleet.host("srv_2");
  await seedApp(db, { id: "theirs", teamId: TEAM_B, serverId: "srv_3" });
  const cluster = await asAdmin(() =>
    createCluster("private", { allTeams: false, teamIds: [TEAM_A] }),
  );
  await asAdmin(() => addClusterMember(cluster.id, "srv_2"));
  const list = await asAdmin(() => listClusterJoinCandidates(cluster.id));
  const by = Object.fromEntries(
    list.map((c) => [c.serverId, c.reasons.map((r) => r.code)]),
  );
  assert.deepEqual(by["srv_2"], ["in_cluster"]);
  assert.deepEqual(by["srv_3"], ["other_teams"]);
  assert.deepEqual(by[SERVER_1], []);
});

test("a cluster of one is allowed and says failover starts at two members", async () => {
  fleet.host("srv_2");
  fleet.host("srv_3");
  const cluster = await asAdmin(() => createCluster("eu", everyone));
  const first = await asAdmin(() => addClusterMember(cluster.id, "srv_2"));
  assert.match(first.note ?? "", /Failover starts at two members/);
  assert.equal(
    failoverOn((await asAdmin(() => listClusterMembers(cluster.id))).length),
    false,
  );
  const second = await asAdmin(() => addClusterMember(cluster.id, "srv_3"));
  assert.equal(second.note, null);
  const members = await asAdmin(() => listClusterMembers(cluster.id));
  assert.deepEqual(
    members.map((m) => m.serverId),
    ["srv_2", "srv_3"],
  );
  assert.equal(failoverOn(members.length), true);
});

test("Deplo's own machine may be a member", async () => {
  const cluster = await asAdmin(() => createCluster("eu", everyone));
  await asAdmin(() => addClusterMember(cluster.id, SERVER_1));
  assert.equal(
    (await asAdmin(() => listClusterMembers(cluster.id)))[0].serverId,
    SERVER_1,
  );
});

test("only an instance admin joins a server; a member or another team's owner is refused", async () => {
  fleet.host("srv_2");
  const cluster = await asAdmin(() => createCluster("eu", everyone));
  for (const who of [asMember, asTeamB])
    await who(async () => {
      await assert.rejects(
        () => addClusterMember(cluster.id, "srv_2"),
        /instance admin/,
      );
      await assert.rejects(
        () => listClusterJoinCandidates(cluster.id),
        /instance admin/,
      );
    });
  assert.equal((await db.select().from(clusterMembers)).length, 0);
});

test("members are visible to a team the cluster is shared with, and to no one else", async () => {
  fleet.host("srv_2");
  const cluster = await asAdmin(() =>
    createCluster("private", { allTeams: false, teamIds: [TEAM_A] }),
  );
  await asAdmin(() => addClusterMember(cluster.id, "srv_2"));
  assert.equal(
    (await asMember(() => listClusterMembers(cluster.id))).length,
    1,
  );
  assert.deepEqual(await asTeamB(() => listClusterMembers(cluster.id)), []);
  assert.equal(await asTeamB(() => getCluster(cluster.id)), null);
});

test("nobody targets a member directly: pickers leave it out and placing on it is refused", async () => {
  fleet.host("srv_2");
  const cluster = await asAdmin(() => createCluster("eu", everyone));
  await asAdmin(() => addClusterMember(cluster.id, "srv_2"));

  const choices = await asMember(() => listServerChoices());
  assert.ok(!choices.some((c) => c.id === "srv_2"));
  assert.ok(choices.some((c) => c.id === "srv_3"));

  await assert.rejects(
    () => assertServerNotInCluster("srv_2"),
    /member of cluster eu/,
  );
  await assert.rejects(
    () =>
      asMember(() =>
        createApp({
          name: "shop",
          source: "compose",
          repo: null,
          compose: COMPOSE,
          deploy: false,
          serverId: "srv_2",
        }),
      ),
    /member of cluster eu/,
  );
  // Another server is still fine, and without a server the App never lands on a member.
  const app = await asMember(() =>
    createApp({
      name: "shop",
      source: "compose",
      repo: null,
      compose: COMPOSE,
      deploy: false,
      serverId: "srv_3",
    }),
  );
  assert.equal(app.serverId, "srv_3");
});
