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
import { seedServerRow } from "./infra-test-helpers";
import { apps as appsTable } from "../db/schema/control-plane/apps";
import { workloadPlacements } from "../db/schema/control-plane/clusters";
import { servers as serversTable } from "../db/schema/control-plane/servers";
import { __resetReleaseCacheForTests } from "../agent/release";
import { __setClusterPinForTest } from "../infra/agent-client/cluster-host";
import { fakeClusterHosts } from "../infra/agent-client/cluster-test-helpers";
import {
  __setRunnerForTest,
  __resetQueueForTest,
} from "../deploy/deploy-queue";
import { createCluster, setClusterTeams } from "./clusters/manage";
import { addClusterMember } from "./clusters/members";
import { listPlacementChoices } from "./clusters/choices";
import {
  applyLeaderReport,
  listWorkloadPlacements,
  PlacementRefusedError,
  PlacementUnavailableError,
  refusalSentence,
} from "./clusters/placement";
import { createApp } from "./apps/create";
import { deleteApp } from "./apps/delete";
import { moveAppToCluster, moveAppToServer } from "./apps/source";
import { listServerChoices } from "./servers/roster";

let db: TestDb;
let pg: PGlite;
let fleet: ReturnType<typeof fakeClusterHosts>;
let origFetch: typeof fetch;
const origIp = process.env.DEPLO_SERVER_IP;

const SUMS =
  `${"a".repeat(64)}  deplo-cluster-linux-amd64\n` +
  `${"b".repeat(64)}  deplo-cluster-linux-arm64\n`;
const COMPOSE =
  'services:\n  web:\n    image: nginx:1.27\n    expose:\n      - "80"\n';
const everyone: { allTeams: boolean; teamIds: string[] } = {
  allTeams: true,
  teamIds: [],
};

// What the leader answers a placement request: a member, or a refusal, as its wire JSON.
let answer: unknown = { member: "srv_2" };
let asked: { cluster: string; workload: Record<string, unknown> }[] = [];

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
  __setRunnerForTest(async () => {});
});

after(async () => {
  __resetTestDb();
  __resetQueueForTest();
  await pg.close();
});

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
        capabilities: ["view", "create_apps", "configure_apps"],
      },
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
  fleet = fakeClusterHosts();
  answer = { member: "srv_2" };
  asked = [];
  // The leader runs on Deplo's own machine, already installed.
  fleet.host(SERVER_1, {
    status: {
      installed: true,
      running: true,
      version: "0.2.0",
      relay: true,
      member: false,
      relayLinks: 0,
    },
    leader: (method, payload) => {
      if (method !== "placement.place") return payload;
      asked.push(JSON.parse(new TextDecoder().decode(payload)));
      return new TextEncoder().encode(JSON.stringify(answer));
    },
  });
  for (const id of ["srv_2", "srv_3", "srv_4"]) fleet.host(id);
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

async function eu(sharing = everyone) {
  const cluster = await asAdmin(() => createCluster("eu", sharing));
  await asAdmin(() => addClusterMember(cluster.id, "srv_2"));
  await asAdmin(() => addClusterMember(cluster.id, "srv_3"));
  return cluster;
}

const newApp = (clusterId: string, name = "web") =>
  createApp({
    name,
    source: "compose",
    repo: null,
    compose: COMPOSE,
    deploy: false,
    clusterId,
  });

async function placementsOf(id: string) {
  return db
    .select()
    .from(workloadPlacements)
    .where(eq(workloadPlacements.workloadId, id));
}

async function appRow(id: string) {
  const [r] = await db.select().from(appsTable).where(eq(appsTable.id, id));
  return r;
}

test("a leader answer places the App: the member runs it, placements and server_id follow", async () => {
  const cluster = await eu();
  const app = await asMember(() => newApp(cluster.id));

  assert.equal(app.serverId, "srv_2");
  assert.equal(app.clusterId, cluster.id);
  const rows = await placementsOf(app.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].memberServerId, "srv_2");
  assert.equal(rows[0].kind, "app");
  assert.equal(rows[0].replica, 0);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].cluster, cluster.id);
  assert.equal(asked[0].workload.name, "web");
  assert.equal(asked[0].workload.limitMb, 0);
});

test("a later leader report moves server_id with it and a waiting App keeps where it was", async () => {
  const cluster = await eu();
  const app = await asMember(() => newApp(cluster.id));
  const report = (members: (string | null)[]) =>
    applyLeaderReport({
      clusterId: cluster.id,
      kind: "app",
      workloadId: app.id,
      members,
      epoch: 2,
    });

  assert.equal(await report(["srv_3", "srv_2"]), true);
  assert.equal((await appRow(app.id)).serverId, "srv_3");
  const all = (await listWorkloadPlacements("app", [app.id])).get(app.id)!;
  assert.deepEqual(
    all.map((p) => [p.replica, p.serverId, p.epoch]),
    [
      [0, "srv_3", 2],
      [1, "srv_2", 2],
    ],
  );

  await report([null]);
  assert.equal((await appRow(app.id)).serverId, "srv_3");
  assert.equal((await placementsOf(app.id))[0].memberServerId, null);
});

test("a report cannot name a server outside the cluster or touch an App of another cluster", async () => {
  const cluster = await eu();
  const app = await asMember(() => newApp(cluster.id));
  await assert.rejects(
    () =>
      applyLeaderReport({
        clusterId: cluster.id,
        kind: "app",
        workloadId: app.id,
        members: ["srv_4"],
        epoch: 1,
      }),
    /not in the cluster/,
  );
  await seedApp(db, { id: "loose", serverId: "srv_4" });
  assert.equal(
    await applyLeaderReport({
      clusterId: cluster.id,
      kind: "app",
      workloadId: "loose",
      members: ["srv_2"],
      epoch: 1,
    }),
    false,
  );
  assert.equal((await appRow("loose")).serverId, "srv_4");
});

test("a refusal is the exact sentence and nothing is created", async () => {
  const cluster = await eu();
  answer = {
    refusal: {
      reason: "no_room",
      neededMb: 512,
      cluster: cluster.id,
      workload: "x",
    },
  };
  await assert.rejects(
    () => asMember(() => newApp(cluster.id)),
    (e: unknown) => {
      assert.ok(e instanceof PlacementRefusedError);
      assert.equal(
        e.message,
        "No server in cluster eu has 512 MB free. Add a server to it or lower web's memory.",
      );
      return true;
    },
  );
  assert.equal((await db.select().from(appsTable)).length, 0);
  assert.equal((await db.select().from(workloadPlacements)).length, 0);
});

test("a refusal on an App that already runs changes nothing: no move, no stop", async () => {
  const cluster = await eu();
  await seedApp(db, { id: "live", serverId: "srv_4", source: "docker-image" });
  await db
    .update(appsTable)
    .set({ dockerImage: "nginx:1", repoUrl: null, repoRepo: null })
    .where(eq(appsTable.id, "live"));
  answer = {
    refusal: {
      reason: "no_room",
      neededMb: 256,
      cluster: cluster.id,
      workload: "live",
    },
  };
  await assert.rejects(
    () => asMember(() => moveAppToCluster("live", cluster.id)),
    /No server in cluster eu has 256 MB free\. Add a server to it or lower live's memory\./,
  );
  const r = await appRow("live");
  assert.equal(r.serverId, "srv_4");
  assert.equal(r.clusterId, null);
  assert.equal(r.migrateFromServerId, null);
  assert.equal((await db.select().from(workloadPlacements)).length, 0);
});

test("the whole fixed set of sentences", () => {
  const names = { cluster: "eu", workload: "web" };
  const r = (reason: "no_member_online" | "no_architecture" | "no_image") => ({
    reason,
    neededMb: 256,
    cluster: "c",
    workload: "w",
  });
  assert.equal(
    refusalSentence(r("no_member_online"), names),
    "No server in cluster eu is online and ready right now, so web has nowhere to run. Bring a server back or add one.",
  );
  assert.equal(
    refusalSentence(r("no_architecture"), names),
    "No server in cluster eu has the kind of processor web was built for. Add a server that does.",
  );
  assert.equal(
    refusalSentence(r("no_image"), names),
    "No server in cluster eu has web's image yet. Try again in a minute.",
  );
});

test("a leader that is not running, or names a stranger, places nothing", async () => {
  const cluster = await eu();
  fleet.host(SERVER_1, {
    status: { ...fleet.host(SERVER_1).status, running: false },
  });
  await assert.rejects(
    () => asMember(() => newApp(cluster.id)),
    PlacementUnavailableError,
  );
  fleet.host(SERVER_1, {
    status: {
      installed: true,
      running: true,
      version: "0.2.0",
      relay: true,
      member: false,
      relayLinks: 0,
    },
    leader: () => new TextEncoder().encode(JSON.stringify({ member: "srv_4" })),
  });
  await assert.rejects(() => asMember(() => newApp(cluster.id)), /not in it/);
  assert.equal((await db.select().from(appsTable)).length, 0);
});

test("a cluster not shared with the team is refused, and its members are never offered", async () => {
  const cluster = await eu({ allTeams: false, teamIds: [TEAM_A] });
  await assert.rejects(
    () => asTeamB(() => newApp(cluster.id)),
    /isn't available to this team/,
  );
  assert.equal(asked.length, 0, "the leader is not even asked");
  assert.equal((await db.select().from(appsTable)).length, 0);

  const b = await asTeamB(() => listPlacementChoices());
  assert.ok(!b.some((c) => c.kind === "cluster"));
  const a = await asMember(() => listPlacementChoices());
  assert.deepEqual(
    a.filter((c) => c.kind === "cluster").map((c) => c.id),
    [cluster.id],
  );
  assert.ok(!a.some((c) => c.id === "srv_2" || c.id === "srv_3"));
  assert.ok(a.some((c) => c.kind === "server" && c.id === "srv_4"));

  // Narrowed later, the team loses it again.
  await asAdmin(() =>
    setClusterTeams(cluster.id, { allTeams: false, teamIds: [TEAM_B] }),
  );
  assert.ok(
    !(await asMember(() => listPlacementChoices())).some(
      (c) => c.kind === "cluster",
    ),
  );
});

test("a member cannot be picked as a server, and a cluster and a server are not both asked for", async () => {
  const cluster = await eu();
  assert.ok(
    !(await asMember(() => listServerChoices())).some((c) => c.id === "srv_2"),
  );
  await assert.rejects(
    () =>
      asMember(() =>
        createApp({
          name: "x",
          source: "compose",
          repo: null,
          compose: COMPOSE,
          deploy: false,
          serverId: "srv_2",
        }),
      ),
    /member of cluster eu/,
  );
  await assert.rejects(
    () =>
      asMember(() =>
        createApp({
          name: "x",
          source: "compose",
          repo: null,
          compose: COMPOSE,
          deploy: false,
          serverId: "srv_4",
          clusterId: cluster.id,
        }),
      ),
    /not both/,
  );
});

test("placing an existing App moves it to the member the leader picked and mirrors it", async () => {
  const cluster = await eu();
  await seedApp(db, { id: "live", serverId: "srv_4", source: "docker-image" });
  await db
    .update(appsTable)
    .set({ dockerImage: "nginx:1", repoUrl: null, repoRepo: null })
    .where(eq(appsTable.id, "live"));
  answer = { member: "srv_3" };
  await asMember(() => moveAppToCluster("live", cluster.id));
  const r = await appRow("live");
  assert.equal(r.serverId, "srv_3");
  assert.equal(r.clusterId, cluster.id);
  assert.equal(r.migrateFromServerId, "srv_4");
  assert.equal((await placementsOf("live"))[0].memberServerId, "srv_3");
});

test("moving an App off its cluster needs move_apps, then it leaves with its placement dropped", async () => {
  const cluster = await eu();
  const app = await asAdmin(() => newApp(cluster.id));
  await assert.rejects(
    () => asMember(() => moveAppToServer(app.id, "srv_4")),
    /move_apps|permission|capab/i,
  );
  assert.equal((await appRow(app.id)).clusterId, cluster.id);

  await asAdmin(() => moveAppToServer(app.id, "srv_4"));
  const r = await appRow(app.id);
  assert.equal(r.serverId, "srv_4");
  assert.equal(r.clusterId, null);
  assert.equal((await placementsOf(app.id)).length, 0);
  // And a member server is still no target for the way back out.
  await assert.rejects(
    () => asAdmin(() => moveAppToServer(app.id, "srv_2")),
    /member of cluster eu/,
  );
});

test("a cluster cannot be taken from a team that still has work on it", async () => {
  const cluster = await eu();
  await asTeamB(() => newApp(cluster.id, "theirs"));
  await assert.rejects(
    () =>
      asAdmin(() =>
        setClusterTeams(cluster.id, { allTeams: false, teamIds: [TEAM_A] }),
      ),
    /These teams still have Apps or databases on this cluster: beta\. Move or delete them before taking the cluster away\./,
  );
  const b = await asTeamB(() => listPlacementChoices());
  assert.ok(
    b.some((c) => c.kind === "cluster"),
    "nothing changed",
  );
  // Keeping the team, or sharing with everyone, is still fine.
  await asAdmin(() =>
    setClusterTeams(cluster.id, { allTeams: false, teamIds: [TEAM_B] }),
  );
});

test("deleting an App drops its placement", async () => {
  const cluster = await eu();
  const app = await asAdmin(() => newApp(cluster.id));
  assert.equal((await placementsOf(app.id)).length, 1);
  await db
    .update(appsTable)
    .set({ status: "idle" })
    .where(eq(appsTable.id, app.id));
  await asAdmin(() => deleteApp(app.id)).catch(() => {});
  assert.equal((await placementsOf(app.id)).length, 0);
});
