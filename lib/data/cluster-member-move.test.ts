import { test } from "node:test";
import assert from "node:assert/strict";

import { and, eq } from "drizzle-orm";

import { SERVER_1 } from "./app-graph-test-helpers";
import { seedDatabase } from "./backup-test-helpers";
import { apps as appsTable } from "../db/schema/control-plane/apps";
import {
  clusterMembers,
  workloadPlacements,
} from "../db/schema/control-plane/clusters";
import { databases as databasesTable } from "../db/schema/control-plane/databases";
import { servers as serversTable } from "../db/schema/control-plane/servers";
import { moveAppToCluster } from "./apps/source";
import { moveDatabaseToCluster } from "./databases/server-move";
import { listClusterServerChoices } from "./clusters/member-choice";
import {
  DATA,
  appRow,
  asAdmin,
  asked,
  db,
  disks,
  emptyLab,
  eu,
  runningApp,
} from "./cluster-empty-test-helpers";

emptyLab();

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
  assert.deepEqual(await placedOn("app", "web"), ["srv_3"]);
  assert.deepEqual(asked, [], "the cluster did not pick");
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

test("a database on a cluster moves to the server of it that is picked", async () => {
  await seedDatabase(db, { id: "db_main", name: "main", serverId: "srv_2" });
  const d = disks.get("srv_2")!;
  d.stacks.set("db-main", "services: {}\n");
  d.volumes.set("deplo-db-main_db-main-data", DATA);
  const cluster = await eu();
  await asAdmin(() => moveDatabaseToCluster("db_main", cluster.id, "srv_3"));
  const [row] = await db
    .select()
    .from(databasesTable)
    .where(eq(databasesTable.id, "db_main"));
  assert.equal(row?.serverId, "srv_3");
  assert.deepEqual(await placedOn("database", "db_main"), ["srv_3"]);
  assert.deepEqual(asked, []);
});
