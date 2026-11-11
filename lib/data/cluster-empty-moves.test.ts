import { test } from "node:test";
import assert from "node:assert/strict";

import { and, eq } from "drizzle-orm";

import { TEAM_B, USER_1 } from "./identity-test-helpers";
import { SERVER_1 } from "./app-graph-test-helpers";
import { seedDatabase } from "./backup-test-helpers";
import {
  clusterMembers,
  workloadPlacements,
} from "../db/schema/control-plane/clusters";
import { databases as databasesTable } from "../db/schema/control-plane/databases";
import { deploMoves } from "../db/schema/control-plane/deplo-move";
import { deployments as deploymentsTable } from "../db/schema/control-plane/deployments";
import { createApp } from "./apps/create";
import { moveAppToCluster } from "./apps/source";
import {
  emptyClusterMember,
  runEmptyingPass,
  stopEmptyingClusterMember,
} from "./clusters/empty";
import {
  __resetClusterWatchForTest,
  releaseClusterWatchLease,
  runClusterWatchTick,
} from "./clusters/watch-scheduler";
import { PlacementUnavailableError } from "./clusters/placement";
import { invalidateFrozen } from "./deplo-move/freeze";
import {
  COMPOSE,
  DATA,
  activity,
  appRow,
  asAdmin,
  asMember,
  asked,
  card,
  db,
  deployLands,
  disks,
  emptyLab,
  eu,
  member,
  pg,
  rosters,
  runningApp,
  setAnswer,
} from "./cluster-empty-test-helpers";

// Emptying a member, once it started: the work moving off it. Starting it is in cluster-empty.test.ts.

emptyLab();

async function deploymentsOf(appId: string) {
  return db
    .select({
      serverId: deploymentsTable.serverId,
      status: deploymentsTable.status,
      creator: deploymentsTable.creator,
    })
    .from(deploymentsTable)
    .where(eq(deploymentsTable.appId, appId))
    .orderBy(deploymentsTable.createdAt);
}

async function placedOn(kind: string, id: string) {
  const rows = await db
    .select({ member: workloadPlacements.memberServerId })
    .from(workloadPlacements)
    .where(
      and(
        eq(workloadPlacements.kind, kind),
        eq(workloadPlacements.workloadId, id),
      ),
    );
  return rows.map((r) => r.member);
}

test("Apps move one at a time, each team sees its own move, and the server ends with none", async () => {
  await runningApp("api", "srv_2");
  await runningApp("web", "srv_2", { teamId: TEAM_B });
  const cluster = await eu();
  await asAdmin(() => emptyClusterMember(cluster.id, "srv_2"));

  await runEmptyingPass();
  assert.deepEqual(
    asked.map((w) => [w.kind, w.id]),
    [["app", "api"]],
    "the leader picks the member, for one App only",
  );
  const api = await appRow("api");
  assert.equal(api.serverId, "srv_3");
  assert.equal(api.clusterId, cluster.id, "it stays on the cluster");
  assert.deepEqual(await deploymentsOf("api"), [
    { serverId: "srv_3", status: "queued", creator: "Deplo" },
  ]);
  assert.deepEqual(await placedOn("app", "api"), ["srv_3"]);
  assert.equal((await appRow("web")).serverId, "srv_2");
  assert.deepEqual((await card(cluster.id, "srv_2")).emptying, {
    since: (await member("srv_2")).emptyingSince,
    total: 2,
    left: 2,
    moving: "api",
    error: "",
  });

  await runEmptyingPass();
  assert.equal(asked.length, 1, "nothing else starts while api is deploying");

  assert.equal(await deployLands("api"), "nothing");
  await runEmptyingPass();
  assert.deepEqual(
    asked.map((w) => w.id),
    ["api", "web"],
  );
  assert.equal((await appRow("web")).serverId, "srv_3");
  const mid = (await card(cluster.id, "srv_2")).emptying!;
  assert.deepEqual([mid.total, mid.left, mid.moving], [2, 1, "web"]);
  assert.equal(
    (await activity(TEAM_B))[0],
    "Deplo: Moved web to srv_3: srv_2 is being emptied",
  );
  assert.ok(
    !(await activity()).some((a) => a.includes("web")),
    "another team's App is not in this team's Activity",
  );

  await deployLands("web");
  await runEmptyingPass();
  const done = (await card(cluster.id, "srv_2")).emptying!;
  assert.deepEqual([done.total, done.left, done.moving], [2, 0, ""]);
  assert.ok(
    (await member("srv_2")).emptyingSince,
    "it keeps taking no work until an admin says otherwise",
  );
  assert.equal(
    (await activity()).at(-1),
    "Deplo: Emptied server srv_2 of cluster eu",
  );
  await runEmptyingPass();
  assert.equal(
    (await activity()).filter((a) => a.includes("Emptied")).length,
    1,
    "said once",
  );
});

test("an App's stored data is copied to the server it moves to, since the old one is alive", async () => {
  await runningApp("blog", "srv_2");
  await pg.exec(
    `insert into app_volumes (volume_id, app_id, position, type, name, mount_path, read_only)
       values ('vol_1', 'blog', 0, 'named', 'data', '/data', false)`,
  );
  const yaml =
    "services:\n  app:\n    image: nginx:1\n    volumes:\n      - deplo-blog-data:/data\nvolumes:\n  deplo-blog-data:\n    name: deplo-blog-data\n";
  disks.get("srv_2")!.stacks.set("blog", yaml);
  disks.get("srv_2")!.volumes.set("deplo-blog-data", DATA);
  const cluster = await eu();
  await asAdmin(() => emptyClusterMember(cluster.id, "srv_2"));
  await runEmptyingPass();
  disks.get("srv_3")!.stacks.set("blog", yaml);
  assert.equal(await deployLands("blog"), "done");
  assert.deepEqual(disks.get("srv_3")!.volumes.get("deplo-blog-data"), DATA);
  assert.ok(!disks.get("srv_2")!.stacks.has("blog"), "the old stack is gone");
  await runEmptyingPass();
  assert.equal((await card(cluster.id, "srv_2")).emptying?.left, 0);
});

async function dbRow(id: string) {
  const [r] = await db
    .select()
    .from(databasesTable)
    .where(eq(databasesTable.id, id));
  return r!;
}

/** A managed database running on `serverId` with data in its volume. */
async function runningDatabase(id: string, name: string, serverId: string) {
  await seedDatabase(db, { id, name, serverId });
  const d = disks.get(serverId)!;
  d.stacks.set(`db-${name}`, "services: {}\n");
  d.volumes.set(`deplo-db-${name}_db-${name}-data`, DATA);
}

test("a database moves first, with its data, and stays on the cluster", async () => {
  await runningDatabase("db_main", "main", "srv_2");
  await runningApp("web", "srv_2");
  const cluster = await eu();
  await asAdmin(() => emptyClusterMember(cluster.id, "srv_2"));
  await runEmptyingPass();

  assert.deepEqual(
    asked.map((w) => [w.kind, w.id]),
    [
      ["database", "db_main"],
      ["app", "web"],
    ],
    "the database is whole before the first App starts moving",
  );
  // No registry described either image, so each is only offered the kind of server it runs on.
  assert.deepEqual(
    asked.map((w) => w.archs),
    [["amd64"], ["amd64"]],
  );
  const moved = await dbRow("db_main");
  assert.equal(moved.serverId, "srv_3");
  assert.equal(moved.clusterId, cluster.id);
  assert.deepEqual(await placedOn("database", "db_main"), ["srv_3"]);
  assert.deepEqual(
    disks.get("srv_3")!.volumes.get("deplo-db-main_db-main-data"),
    DATA,
    "the data was copied across",
  );
  assert.ok(!disks.get("srv_2")!.stacks.has("db-main"));
  assert.ok(
    (await activity()).includes(
      "Deplo: Moved database main to srv_3: srv_2 is being emptied",
    ),
  );
  const now = (await card(cluster.id, "srv_2")).emptying!;
  assert.deepEqual([now.total, now.left, now.moving], [2, 1, "web"]);
});

const NO_ROOM_FOR_WEB =
  "No server in cluster eu has 256 MB free. Add a server to it or lower web's memory.";

test("when the leader finds no room half-way, emptying stops with that sentence and goes on when asked to continue", async () => {
  await runningApp("api", "srv_2");
  await runningApp("web", "srv_2");
  const cluster = await eu();
  setAnswer((w) =>
    w.id === "web"
      ? {
          refusal: {
            reason: "no_room",
            neededMb: 256,
            cluster: cluster.id,
            workload: "web",
          },
        }
      : { member: "srv_3" },
  );
  await asAdmin(() => emptyClusterMember(cluster.id, "srv_2"));
  await runEmptyingPass();
  await deployLands("api");
  await runEmptyingPass();

  const stopped = (await card(cluster.id, "srv_2")).emptying!;
  assert.deepEqual(
    [stopped.left, stopped.moving, stopped.error],
    [1, "", NO_ROOM_FOR_WEB],
  );
  assert.equal(
    (await activity()).at(-1),
    `Deplo: Stopped emptying server srv_2 of cluster eu: ${NO_ROOM_FOR_WEB}`,
  );
  assert.equal((await appRow("web")).serverId, "srv_2");
  assert.deepEqual(disks.get("srv_2")!.calls, ["destroy:api"]);

  await runEmptyingPass();
  assert.equal(asked.length, 2, "a stopped emptying asks nothing again");

  setAnswer(() => ({ member: "srv_3" }));
  await asAdmin(() => emptyClusterMember(cluster.id, "srv_2"));
  assert.equal(
    (await activity()).at(-1),
    "user_1: Continued emptying server srv_2 of cluster eu",
  );
  assert.equal((await card(cluster.id, "srv_2")).emptying?.error, "");
  await runEmptyingPass();
  assert.equal((await appRow("web")).serverId, "srv_3");
});

test("an App whose move was rolled back is not moved again in a loop", async () => {
  await runningApp("blog", "srv_2");
  await pg.exec(
    `insert into app_volumes (volume_id, app_id, position, type, name, mount_path, read_only)
       values ('vol_1', 'blog', 0, 'named', 'data', '/data', false)`,
  );
  const yaml =
    "services:\n  app:\n    image: nginx:1\n    volumes:\n      - deplo-blog-data:/data\nvolumes:\n  deplo-blog-data:\n    name: deplo-blog-data\n";
  disks.get("srv_2")!.stacks.set("blog", yaml);
  disks.get("srv_2")!.volumes.set("deplo-blog-data", DATA);
  disks.get("srv_3")!.fail.import = "disk full";
  const cluster = await eu();
  await asAdmin(() => emptyClusterMember(cluster.id, "srv_2"));
  await runEmptyingPass();
  disks.get("srv_3")!.stacks.set("blog", yaml);
  assert.equal(await deployLands("blog"), "rolled-back");
  await runEmptyingPass();
  assert.equal((await appRow("blog")).serverId, "srv_2");
  assert.equal(
    (await card(cluster.id, "srv_2")).emptying?.error,
    "blog could not be moved, so it is still on this server. Its last deployment says why.",
  );
  await runEmptyingPass();
  assert.equal(asked.length, 1);
  assert.equal((await deploymentsOf("blog")).length, 1);
});

test("a deploy that fails on the new server stops emptying, and continuing deploys it again", async () => {
  await runningApp("api", "srv_2");
  const cluster = await eu();
  await asAdmin(() => emptyClusterMember(cluster.id, "srv_2"));
  await runEmptyingPass();
  await db
    .update(deploymentsTable)
    .set({ status: "error" })
    .where(eq(deploymentsTable.appId, "api"));
  await runEmptyingPass();
  assert.equal(
    (await card(cluster.id, "srv_2")).emptying?.error,
    "api did not finish moving to its new server. Its last deployment says why.",
  );
  assert.equal((await card(cluster.id, "srv_2")).emptying?.left, 1);

  await asAdmin(() => emptyClusterMember(cluster.id, "srv_2"));
  await runEmptyingPass();
  assert.deepEqual(
    (await deploymentsOf("api")).map((d) => [d.status, d.creator]),
    [
      ["error", "Deplo"],
      ["queued", "Deplo"],
    ],
  );
  assert.equal(asked.length, 1, "the leader already chose where it goes");
  await deployLands("api");
  await runEmptyingPass();
  assert.equal((await card(cluster.id, "srv_2")).emptying?.left, 0);
});

test("after a restart in the middle, the next pass picks up what was cut off", async () => {
  await runningDatabase("db_main", "main", "srv_2");
  await runningApp("api", "srv_2");
  const cluster = await eu();
  await asAdmin(() => emptyClusterMember(cluster.id, "srv_2"));
  // Deplo went away while the database was being copied: the row still names it, and it never left.
  await db
    .update(clusterMembers)
    .set({ emptyingWorkload: "database:db_main" })
    .where(eq(clusterMembers.serverId, "srv_2"));
  await runEmptyingPass();
  assert.equal((await dbRow("db_main")).serverId, "srv_3");
  assert.equal((await appRow("api")).serverId, "srv_3");

  // Deplo went away again after api's deploy was ready and before its data was carried over.
  await db
    .update(deploymentsTable)
    .set({ status: "ready", readyAt: "2026-01-01T00:00:00.000Z" })
    .where(eq(deploymentsTable.appId, "api"));
  await runEmptyingPass();
  assert.deepEqual(
    (await deploymentsOf("api")).map((d) => d.status),
    ["ready", "queued"],
    "a new deploy carries the data",
  );
  assert.equal((await card(cluster.id, "srv_2")).emptying?.error, "");
  await deployLands("api");
  await runEmptyingPass();
  assert.equal((await card(cluster.id, "srv_2")).emptying?.left, 0);
});

test("stop emptying: the server takes work again and nothing else moves", async () => {
  await runningApp("api", "srv_2");
  await runningApp("web", "srv_2");
  const cluster = await eu();
  await asAdmin(() => emptyClusterMember(cluster.id, "srv_2"));
  await runEmptyingPass();
  rosters.length = 0;
  await asAdmin(() => stopEmptyingClusterMember(cluster.id, "srv_2"));
  assert.equal((await member("srv_2")).emptyingSince, null);
  assert.equal((await card(cluster.id, "srv_2")).emptying, null);
  assert.equal(
    (await activity()).at(-1),
    "user_1: Stopped emptying server srv_2 of cluster eu",
  );
  assert.equal(rosters.length, 1, "the leader is told");
  await deployLands("api");
  await runEmptyingPass();
  assert.equal(asked.length, 1);
  assert.equal((await appRow("web")).serverId, "srv_2");

  await asAdmin(() => stopEmptyingClusterMember(cluster.id, "srv_2"));
  assert.equal(
    (await activity()).filter((a) => a.includes("Stopped emptying")).length,
    1,
    "stopping twice says it once",
  );
});

test("nothing moves while a Deplo move freezes this instance", async () => {
  await runningApp("api", "srv_2");
  const cluster = await eu();
  await asAdmin(() => emptyClusterMember(cluster.id, "srv_2"));
  await db.insert(deploMoves).values({
    id: "dmv_1",
    side: "target",
    state: "copying",
    peerUrl: "https://new.example.com",
    startedBy: USER_1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  invalidateFrozen();
  await runEmptyingPass();
  assert.deepEqual(asked, []);
  assert.equal((await appRow("api")).serverId, "srv_2");
});

test("while a server is being emptied nothing new is placed on it, whatever the leader answers", async () => {
  const cluster = await eu();
  await asAdmin(() => emptyClusterMember(cluster.id, "srv_2"));
  setAnswer(() => ({ member: "srv_2" }));
  const refused = (e: unknown) =>
    e instanceof PlacementUnavailableError &&
    e.message ===
      "Cluster eu's leader named a server that is being emptied. Try again in a moment.";
  await assert.rejects(
    asMember(() =>
      createApp({
        name: "web",
        source: "compose",
        repo: null,
        compose: COMPOSE,
        deploy: false,
        clusterId: cluster.id,
      }),
    ),
    refused,
  );
  await runningApp("solo", SERVER_1);
  await assert.rejects(
    asAdmin(() => moveAppToCluster("solo", cluster.id)),
    refused,
  );
  assert.equal((await appRow("solo")).serverId, SERVER_1);
  assert.deepEqual(
    await db.select().from(workloadPlacements),
    [],
    "nothing was placed",
  );

  await asAdmin(() => stopEmptyingClusterMember(cluster.id, "srv_2"));
  const web = await asMember(() =>
    createApp({
      name: "web",
      source: "compose",
      repo: null,
      compose: COMPOSE,
      deploy: false,
      clusterId: cluster.id,
    }),
  );
  assert.equal((await appRow(web.id)).serverId, "srv_2");
});

test("the cluster tick is what drives emptying in the background", async () => {
  await runningApp("api", "srv_2");
  const cluster = await eu();
  await asAdmin(() => emptyClusterMember(cluster.id, "srv_2"));
  try {
    await runClusterWatchTick();
    // No timer: the stubbed deploy runner keeps the queue busy, and each read lets the pass move on.
    for (
      let i = 0;
      i < 5000 && (await appRow("api")).serverId !== "srv_3";
      i++
    );
    assert.equal((await appRow("api")).serverId, "srv_3");
  } finally {
    __resetClusterWatchForTest();
    await releaseClusterWatchLease();
    await runEmptyingPass();
  }
});
