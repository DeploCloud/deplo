import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { runWithIdentity } from "../auth/request-context";
import { seedIdentity, TEAM_A, TEAM_B, USER_1 } from "./identity-test-helpers";
import {
  seedServer,
  SERVER_1,
  TRUNCATE_PROJECT_GRAPH,
} from "./app-graph-test-helpers";
import { activities } from "../db/schema/control-plane/activity";
import { clusters as clustersTable } from "../db/schema/control-plane/clusters";
import { __resetReleaseCacheForTests } from "../agent/release";
import { __setClusterPinForTest } from "../infra/agent-client/cluster-host";
import { fakeClusterHosts } from "../infra/agent-client/cluster-test-helpers";
import {
  createCluster,
  renameCluster,
  setClusterTeams,
} from "./clusters/manage";
import { ensureClusterLeader, getClusterLeader } from "./clusters/leader";
import {
  getCluster,
  getClusterTeamIds,
  listAllClusters,
  listClusters,
  listClustersForTeam,
} from "./clusters/roster";
import { removeServer } from "./servers/removal";

let db: TestDb;
let pg: PGlite;
let fleet: ReturnType<typeof fakeClusterHosts>;
let origFetch: typeof fetch;
const origIp = process.env.DEPLO_SERVER_IP;

const SUMS =
  `${"a".repeat(64)}  deplo-cluster-linux-amd64\n` +
  `${"b".repeat(64)}  deplo-cluster-linux-arm64\n`;

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
    truncate table clusters, registration_links, membership_capabilities, memberships, users, teams restart identity cascade;`);
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      { id: "user_b", teamId: TEAM_B, role: "owner", isInstanceAdmin: false },
      { id: "user_member", teamId: TEAM_A, role: "member" },
    ],
  });
  await seedServer(db);
  // The seeded server stands for Deplo's own machine.
  process.env.DEPLO_SERVER_IP = "10.0.0.1";
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

const asAdmin = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);
const asMember = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: "user_member", teamId: TEAM_A }, fn);
const asTeamB = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: "user_b", teamId: TEAM_B }, fn);

const everyone = { allTeams: true, teamIds: [] };

async function activityMessages(): Promise<string[]> {
  const rows = await db.select().from(activities);
  return rows.map((a) => a.message);
}

test("creating a cluster starts the leader on Deplo's machine and says where it runs", async () => {
  const host = fleet.host(SERVER_1);
  const cluster = await asAdmin(() => createCluster("  eu  ", everyone));
  assert.equal(cluster.name, "eu");
  assert.equal(cluster.allTeams, true);
  assert.equal(cluster.leaderServerId, null);
  assert.equal(host.installs.length, 1);
  const leader = await asAdmin(() => getClusterLeader(cluster.id));
  assert.equal(leader.state, "running");
  assert.equal(leader.serverId, SERVER_1);
  assert.equal(leader.onDeploHost, true);
  assert.equal(leader.version, "0.2.0");
});

test("a second cluster finds the leader already running and installs nothing", async () => {
  const host = fleet.host(SERVER_1);
  await asAdmin(() => createCluster("eu", everyone));
  await asAdmin(() => createCluster("us", everyone));
  assert.equal(host.installs.length, 1);
});

test("a leader that cannot start never undoes the cluster, and the card says why", async () => {
  fleet.host(SERVER_1, { capabilities: [] });
  const cluster = await asAdmin(() => createCluster("eu", everyone));
  assert.ok(await getCluster_(cluster.id));
  const leader = await asAdmin(() => getClusterLeader(cluster.id));
  assert.equal(leader.state, "unavailable");
  assert.match(leader.message, /too old/);
});

test("an unreachable machine reads as unreachable, and starting it again works once it answers", async () => {
  const cluster = await asAdmin(() => createCluster("eu", everyone));
  assert.equal(
    (await asAdmin(() => getClusterLeader(cluster.id))).state,
    "unreachable",
  );
  const host = fleet.host(SERVER_1);
  const after = await asAdmin(() => ensureClusterLeader(cluster.id));
  assert.equal(after.state, "running");
  assert.equal(host.installs.length, 1);
  assert.ok(
    (await activityMessages()).some((m) =>
      /Started the leader of cluster eu/.test(m),
    ),
  );
});

test("with Deplo's machine not connected as a server there is nowhere to start it", async () => {
  process.env.DEPLO_SERVER_IP = "10.9.9.9";
  const cluster = await asAdmin(() => createCluster("eu", everyone));
  const leader = await asAdmin(() => getClusterLeader(cluster.id));
  assert.equal(leader.state, "unavailable");
  assert.equal(leader.serverId, null);
});

test("create, rename and sharing each leave an Activity entry", async () => {
  fleet.host(SERVER_1);
  const c = await asAdmin(() => createCluster("eu", everyone));
  await asAdmin(() => renameCluster(c.id, "europe"));
  await asAdmin(() =>
    setClusterTeams(c.id, { allTeams: false, teamIds: [TEAM_A] }),
  );
  const messages = await activityMessages();
  for (const re of [
    /Created cluster eu, shared with all teams/,
    /Renamed cluster eu to europe/,
    /Shared cluster europe with 1 team$/,
  ])
    assert.ok(
      messages.some((m) => re.test(m)),
      `${re} in ${messages.join(" | ")}`,
    );
});

test("names are required, short and unique", async () => {
  fleet.host(SERVER_1);
  await asAdmin(async () => {
    await assert.rejects(() => createCluster("   ", everyone), /needs a name/);
    await assert.rejects(
      () => createCluster("a".repeat(61), everyone),
      /60 characters/,
    );
    const c = await createCluster("eu", everyone);
    await assert.rejects(() => createCluster("EU", everyone), /already exists/);
    const us = await createCluster("us", everyone);
    await assert.rejects(() => renameCluster(us.id, "eu"), /already exists/);
    assert.equal((await renameCluster(c.id, "eu")).name, "eu");
    await assert.rejects(() => renameCluster("clu_nope", "x"), /not found/);
  });
});

test("a team a cluster is not shared with cannot see it", async () => {
  fleet.host(SERVER_1);
  const open = await asAdmin(() => createCluster("open", everyone));
  const shared = await asAdmin(() =>
    createCluster("private", { allTeams: false, teamIds: [TEAM_A] }),
  );
  assert.deepEqual(await getClusterTeamIds(shared.id), [TEAM_A]);

  const names = (cs: { name: string }[]) => cs.map((c) => c.name).sort();
  assert.deepEqual(names(await listClustersForTeam(TEAM_A)), [
    "open",
    "private",
  ]);
  assert.deepEqual(names(await listClustersForTeam(TEAM_B)), ["open"]);
  assert.deepEqual(names(await asTeamB(() => listClusters())), ["open"]);
  assert.equal(await asTeamB(() => getCluster(shared.id)), null);
  assert.equal((await asTeamB(() => getCluster(open.id)))?.name, "open");
  assert.equal((await asAdmin(() => getCluster(shared.id)))?.name, "private");
});

test("widening or narrowing the sharing takes effect at once", async () => {
  fleet.host(SERVER_1);
  const c = await asAdmin(() =>
    createCluster("eu", { allTeams: false, teamIds: [TEAM_A] }),
  );
  assert.equal(await asTeamB(() => getCluster(c.id)), null);
  await asAdmin(() => setClusterTeams(c.id, everyone));
  assert.ok(await asTeamB(() => getCluster(c.id)));
  assert.deepEqual(await getClusterTeamIds(c.id), []);
  await asAdmin(() =>
    setClusterTeams(c.id, { allTeams: false, teamIds: [TEAM_B] }),
  );
  assert.deepEqual(await getClusterTeamIds(c.id), [TEAM_B]);
  await asAdmin(async () => {
    await assert.rejects(
      () => setClusterTeams(c.id, { allTeams: false, teamIds: ["team_nope"] }),
      /no longer exist/,
    );
  });
});

test("a non-admin is refused by every write and by the admin reads", async () => {
  fleet.host(SERVER_1);
  const c = await asAdmin(() => createCluster("eu", everyone));
  for (const who of [asMember, asTeamB]) {
    await who(async () => {
      const refused = /instance admin/;
      await assert.rejects(() => createCluster("x", everyone), refused);
      await assert.rejects(() => renameCluster(c.id, "x"), refused);
      await assert.rejects(() => setClusterTeams(c.id, everyone), refused);
      await assert.rejects(() => ensureClusterLeader(c.id), refused);
      await assert.rejects(() => getClusterLeader(c.id), refused);
      await assert.rejects(() => listAllClusters(), refused);
    });
  }
  const [row] = await db.select().from(clustersTable);
  assert.equal(row.name, "eu");
});

test("a server that leads a cluster cannot be removed from under it", async () => {
  fleet.host(SERVER_1);
  const c = await asAdmin(() => createCluster("eu", everyone));
  await seedServer(db, "srv_2");
  process.env.DEPLO_SERVER_IP = "10.9.9.9";
  await db
    .update(clustersTable)
    .set({ leaderServerId: "srv_2" })
    .where(eq(clustersTable.id, c.id));
  await asAdmin(async () => {
    await assert.rejects(() => removeServer("srv_2"), /leader of cluster eu/);
  });
});

async function getCluster_(id: string) {
  return asAdmin(() => getCluster(id));
}
