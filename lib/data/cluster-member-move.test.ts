import { test } from "node:test";
import assert from "node:assert/strict";

import { and, eq } from "drizzle-orm";

import { SERVER_1 } from "./app-graph-test-helpers";
import { seedDatabase } from "./backup-test-helpers";
import { apps as appsTable, appVolumes } from "../db/schema/control-plane/apps";
import type { ServerMetrics } from "./monitoring";
import {
  clearMetricsHistory,
  recordMetricsSample,
} from "../monitoring/history";
import { VOLUME_USAGE_CAPABILITY } from "../infra/agent-client/hello-capabilities";
import { clusterMemberFacts } from "./clusters/facts";
import {
  clusterMembers,
  workloadPlacements,
} from "../db/schema/control-plane/clusters";
import { databases as databasesTable } from "../db/schema/control-plane/databases";
import { deployments } from "../db/schema/control-plane/deployments";
import { servers as serversTable } from "../db/schema/control-plane/servers";
import { moveClusterDataBeforeStart } from "./app-migration";
import { moveAppToCluster } from "./apps/source";
import { moveDatabaseToCluster } from "./databases/server-move";
import { factsWait, listClusterServerChoices } from "./clusters/member-choice";
import { __setRunnerForTest } from "../deploy/deploy-queue";
import {
  DATA,
  appRow,
  asAdmin,
  asked,
  db,
  disks,
  emptyLab,
  eu,
  hosts,
  rosters,
  runningApp,
} from "./cluster-empty-test-helpers";

emptyLab();

// Where the last roster the leader took places a workload: what its renewals name from then on.
function rosterPlaces(kind: string, id: string): string | undefined {
  const last = rosters.at(-1) as
    { placement: { kind: string; id: string; member: string }[] } | undefined;
  return last?.placement.find((e) => e.kind === kind && e.id === id)?.member;
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

test("an App on a cluster moves to the server of it that is picked, and the leader is not asked", async () => {
  await runningApp("web", "srv_2");
  const cluster = await eu();
  await asAdmin(() => moveAppToCluster("web", cluster.id, "srv_3"));
  const web = await appRow("web");
  assert.deepEqual([web.serverId, web.clusterId], ["srv_3", cluster.id]);
  await moveClusterDataBeforeStart("web", "srv_3", "web", () => {});
  assert.deepEqual(await placedOn("app", "web"), ["srv_3"]);
  assert.deepEqual(asked, [], "the cluster did not pick");
});

test("a move between two servers of a cluster reaches the leader before its deploy starts it", async () => {
  await runningApp("web", "srv_2");
  const cluster = await eu();
  let leaderHad: string | undefined = "no deploy";
  let queued: string | undefined;
  // The stand-in settles its row: one left queued is picked again at once, forever.
  __setRunnerForTest(async (depId) => {
    queued = rosterPlaces("app", "web");
    await moveClusterDataBeforeStart("web", "srv_3", "web", () => {});
    leaderHad = rosterPlaces("app", "web");
    await db
      .update(deployments)
      .set({ status: "canceled" })
      .where(eq(deployments.id, depId));
  });
  try {
    await asAdmin(() => moveAppToCluster("web", cluster.id, "srv_3"));
    for (let i = 0; i < 100 && leaderHad === "no deploy"; i++)
      await new Promise((r) => setTimeout(r, 20));
  } finally {
    __setRunnerForTest(async () => {});
  }
  assert.notEqual(queued, "srv_3", "its old member ran it while it queued");
  assert.equal(leaderHad, "srv_3", "the leader placed it there first");
  assert.deepEqual(await placedOn("app", "web"), ["srv_3"]);
});

test("an App outside the cluster lands on the server of it that is picked", async () => {
  await runningApp("solo", SERVER_1);
  const cluster = await eu();
  await asAdmin(() => moveAppToCluster("solo", cluster.id, "srv_2"));
  const solo = await appRow("solo");
  assert.deepEqual([solo.serverId, solo.clusterId], ["srv_2", cluster.id]);
  assert.deepEqual(asked, []);
});

test("a server that cannot take it is refused in words before anything moves", async () => {
  await runningApp("web", "srv_2", { memoryMb: 512 });
  const cluster = await eu();
  const refused = async (message: string) => {
    await assert.rejects(
      asAdmin(() => moveAppToCluster("web", cluster.id, "srv_3")),
      { message },
    );
    assert.equal((await appRow("web")).serverId, "srv_2");
  };

  await db
    .update(serversTable)
    .set({ memoryMb: 300 })
    .where(eq(serversTable.id, "srv_3"));
  await refused("srv_3 has 300 MB free and web needs 512 MB.");

  await db
    .update(clusterMembers)
    .set({ leaseState: "fenced" })
    .where(eq(clusterMembers.serverId, "srv_3"));
  await refused("srv_3 is offline, so web cannot move there now.");

  await db
    .update(appsTable)
    .set({ replicas: 2 })
    .where(eq(appsTable.id, "web"));
  await refused(
    "web runs 2 replicas, and cluster eu spreads them over its servers.",
  );

  await assert.rejects(
    asAdmin(() => moveAppToCluster("web", cluster.id, "srv_4")),
    { message: "That server is not in cluster eu." },
  );
});

// c46: the first move onto eu-4, 8 s after it joined, was refused as "eu-4 has 0 MB free" (its memory, unknown yet).
test("a move onto a member without metrics yet waits for them, and the picker says so", async () => {
  await runningApp("web", "srv_2");
  const cluster = await eu();
  const memory = (memoryMb: number) =>
    db
      .update(serversTable)
      .set({ memoryMb })
      .where(eq(serversTable.id, "srv_3"));
  await memory(0);
  const waiting =
    "Waiting for srv_3's first metrics, to know whether web fits there.";
  const [choice] = await asAdmin(() =>
    listClusterServerChoices({
      id: "web",
      name: "web",
      limitMb: 0,
      archs: [],
      clusterId: cluster.id,
      serverId: "srv_2",
    }),
  );
  assert.equal(choice?.servers.find((s) => s.id === "srv_3")?.refusal, waiting);

  Object.assign(factsWait, { everyMs: 5, maxMs: 30 });
  try {
    await assert.rejects(
      asAdmin(() => moveAppToCluster("web", cluster.id, "srv_3")),
      {
        message:
          "No metrics came from srv_3 within 0 s, so Deplo does not know its memory yet and cannot tell whether web fits there.",
      },
    );
    assert.equal((await appRow("web")).serverId, "srv_2");

    factsWait.maxMs = 2_000;
    const moved = asAdmin(() => moveAppToCluster("web", cluster.id, "srv_3"));
    await new Promise((r) => setTimeout(r, 50));
    await memory(8192);
    await moved;
    assert.equal((await appRow("web")).serverId, "srv_3");
  } finally {
    Object.assign(factsWait, { everyMs: 1_000, maxMs: 60_000 });
  }
});

// c47: eu-4's first metrics came 27 s after its agent started, and the move waiting for them was refused at 20 s.
test("a move onto a member without metrics yet asks the member for them and goes", async () => {
  await runningApp("web", "srv_2");
  const cluster = await eu();
  await db
    .update(serversTable)
    .set({ memoryMb: 0 })
    .where(eq(serversTable.id, "srv_3"));
  hosts.get("srv_3")!.extra.metrics = async () =>
    ({ cpuCores: 2, memTotal: 8192 * 1024 * 1024, diskTotal: 0 }) as never;
  Object.assign(factsWait, { everyMs: 5, maxMs: 2_000 });
  try {
    await asAdmin(() => moveAppToCluster("web", cluster.id, "srv_3"));
    assert.equal((await appRow("web")).serverId, "srv_3");
    const [srv] = await db
      .select({ memoryMb: serversTable.memoryMb })
      .from(serversTable)
      .where(eq(serversTable.id, "srv_3"));
    assert.equal(srv?.memoryMb, 8192);
  } finally {
    Object.assign(factsWait, { everyMs: 1_000, maxMs: 60_000 });
  }
});

test("the Move picker names each server of the cluster, the one it runs on and why another cannot take it", async () => {
  await runningApp("web", "srv_2");
  const cluster = await eu();
  await db
    .update(clusterMembers)
    .set({ leaseState: "fenced" })
    .where(eq(clusterMembers.serverId, "srv_3"));
  const [choice] = await asAdmin(() =>
    listClusterServerChoices({
      id: "web",
      name: "web",
      limitMb: 0,
      archs: [],
      clusterId: cluster.id,
      serverId: "srv_2",
    }),
  );
  assert.deepEqual(
    choice?.servers.map((s) => [s.id, s.here, s.refusal]),
    [
      ["srv_2", true, null],
      ["srv_3", false, "srv_3 is offline, so web cannot move there now."],
    ],
  );
});

// eu, 24 Nov 2026: two new Apps landed on the member with the least room. A move never takes an App's data to a
// server it would leave with less than a tenth of its disk free (ADR-0043).
test("a server without room for an App's data is refused in words before anything moves", async () => {
  await runningApp("web", "srv_2");
  await db.insert(appVolumes).values({
    appId: "web",
    position: 0,
    volumeId: "vol_web",
    type: "named",
    name: "data",
    hostPath: null,
    mountPath: "/data",
    readOnly: false,
  });
  disks.get("srv_2")!.volumes.set("deplo-web-data", Buffer.alloc(50));
  hosts.get("srv_2")!.capabilities.push(VOLUME_USAGE_CAPABILITY);
  const cluster = await eu();
  const sample = (serverId: string, used: number) =>
    recordMetricsSample({
      serverId,
      online: true,
      diskUsed: used,
      diskTotal: 1000,
      ts: Date.now(),
    } as ServerMetrics);
  sample("srv_3", 870);
  await assert.rejects(
    asAdmin(() => moveAppToCluster("web", cluster.id, "srv_3")),
    {
      message:
        "srv_3 has 130 B free, too little for web's data (about 50 B) and a tenth of its disk free.",
    },
  );
  assert.equal((await appRow("web")).serverId, "srv_2");
  const [choice] = await asAdmin(() =>
    listClusterServerChoices({
      id: "web",
      name: "web",
      limitMb: 0,
      archs: [],
      clusterId: cluster.id,
      serverId: "srv_2",
    }),
  );
  assert.match(choice!.servers[1]!.refusal ?? "", /too little for web's data/);
  // The leader is told each server's disk, for a failover while Deplo is away.
  const facts = await clusterMemberFacts(cluster.id);
  assert.deepEqual(
    facts.map((f) => [f.id, f.diskFree, f.diskTotal]),
    [
      ["srv_2", 0, 0],
      ["srv_3", 130, 1000],
    ],
  );
  clearMetricsHistory("srv_3");
  sample("srv_3", 800);
  await asAdmin(() => moveAppToCluster("web", cluster.id, "srv_3"));
  assert.equal((await appRow("web")).serverId, "srv_3");
  clearMetricsHistory();
});

test("a database on a cluster moves to the server of it that is picked", async () => {
  await seedDatabase(db, { id: "db_main", name: "main", serverId: "srv_2" });
  const d = disks.get("srv_2")!;
  d.stacks.set("db-main", "services: {}\n");
  d.volumes.set("deplo-db-main_db-main-data", DATA);
  const cluster = await eu();
  // Each start on the new server, with where the leader placed the database at that moment.
  const starts: (string | undefined)[] = [];
  const calls = disks.get("srv_3")!.calls;
  const push = calls.push.bind(calls);
  calls.push = (...v: string[]) => {
    for (const c of v)
      if (c === "start:db-main")
        starts.push(rosterPlaces("database", "db_main"));
    return push(...v);
  };
  await asAdmin(() => moveDatabaseToCluster("db_main", cluster.id, "srv_3"));
  assert.deepEqual(
    starts,
    ["srv_3"],
    "started only once the leader placed it there",
  );
  const [row] = await db
    .select()
    .from(databasesTable)
    .where(eq(databasesTable.id, "db_main"));
  assert.equal(row?.serverId, "srv_3");
  assert.deepEqual(await placedOn("database", "db_main"), ["srv_3"]);
  assert.deepEqual(asked, []);
});
