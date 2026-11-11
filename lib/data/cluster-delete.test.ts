import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { eq } from "drizzle-orm";

import { SERVER_1 } from "./app-graph-test-helpers";
import { seedDatabase } from "./backup-test-helpers";
import { TEAM_B } from "./identity-test-helpers";
import { backups as backupsTable } from "../db/schema/control-plane/backups";
import {
  clusterLeaderKeys,
  clusterMembers,
  workloadPlacements,
} from "../db/schema/control-plane/clusters";
import { databases as databasesTable } from "../db/schema/control-plane/databases";
import { panelRoute } from "../deploy/traefik-stack";
import {
  RUNNING,
  activity,
  appRow,
  asAdmin,
  asMember,
  asTeamB,
  clusterNames,
  clusterOf,
  copiesOf,
  db,
  dbRow,
  dissolveHarness,
  hosts,
  leaderOn,
  placed,
  placementsOf,
  pushesOf,
  relayRosters,
  runningApp,
  seedClusterState,
  server,
  told,
} from "./cluster-dissolve-test-helpers";
import {
  deleteCluster,
  getClusterDeletion,
  reconcileDissolvedClusters,
  reconcileLeftMembers,
} from "./clusters/dissolve";
import { moveClusterLeader } from "./clusters/leader-move";

dissolveHarness();

test("deleting a cluster leaves every workload where it runs, as an ordinary one, and nothing of the cluster behind", async () => {
  await runningApp("web", "srv_2");
  await runningApp("api", "srv_3", TEAM_B);
  await seedDatabase(db(), { id: "db_main", name: "main", serverId: "srv_3" });
  const eu = await clusterOf("eu", ["srv_2", "srv_3"]);
  await clusterOf("us", ["srv_4"]);
  await seedClusterState(eu.id, "web");

  await asAdmin(() => deleteCluster(eu.id));

  assert.deepEqual(await clusterNames(), ["us"]);
  for (const [id, on] of [
    ["web", "srv_2"],
    ["api", "srv_3"],
  ]) {
    const app = await appRow(id);
    assert.equal(app.serverId, on);
    assert.equal(app.clusterId, null);
    assert.deepEqual(await placementsOf(id), []);
  }
  const main = await dbRow("db_main");
  assert.equal(main.serverId, "srv_3");
  assert.equal(main.clusterId, null);
  assert.deepEqual(await placementsOf("db_main"), []);
  assert.deepEqual(await pushesOf("web"), []);
  assert.deepEqual(await copiesOf("web"), []);
  assert.deepEqual(
    await db()
      .select()
      .from(clusterMembers)
      .where(eq(clusterMembers.clusterId, eu.id)),
    [],
  );
  assert.deepEqual(
    await db()
      .select()
      .from(clusterLeaderKeys)
      .where(eq(clusterLeaderKeys.clusterId, eu.id)),
    [],
  );

  // The leader drops the cluster with its bundles, the relay lets nobody of it through, and each member is told.
  assert.deepEqual(told[SERVER_1].forgotten, [eu.id]);
  assert.deepEqual(
    relayRosters(hosts[SERVER_1])
      .filter((r) => r.cluster === eu.id)
      .at(-1),
    { cluster: eu.id, parties: [] },
  );
  for (const id of ["srv_2", "srv_3"]) {
    assert.deepEqual(hosts[id].memberCalls, [{ member: false, relays: [] }]);
    assert.deepEqual(hosts[id].stack, [], "nothing was stopped or redeployed");
    assert.equal((await server(id)).clusterLeavePendingAt, null);
  }
  // Another cluster still needs the leader and the relay on Deplo's machine.
  assert.equal(hosts[SERVER_1].removes, 0);
  assert.deepEqual(hosts.srv_4.memberCalls, []);

  assert.equal(
    (await activity()).at(-1),
    "user_1: Deleted cluster eu: this team's 1 App and 1 database stay where they run and no longer fail over. web can no longer reach main by its name: they run on different servers.",
  );
  assert.equal(
    (await activity(TEAM_B)).at(-1),
    "user_1: Deleted cluster eu: this team's 1 App stays where it runs and no longer fails over",
  );
});

test("only an instance admin deletes a cluster, in a team it is shared with or not", async () => {
  await runningApp("web", "srv_2");
  const eu = await clusterOf("eu", ["srv_2"]);
  for (const as of [asMember, asTeamB])
    await assert.rejects(
      as(() => deleteCluster(eu.id)),
      /Only an instance admin can do that/,
    );
  assert.deepEqual(await clusterNames(), ["eu"]);
  assert.equal((await appRow("web")).clusterId, eu.id);
  assert.deepEqual(told[SERVER_1].forgotten, []);
  assert.deepEqual(hosts.srv_2.memberCalls, []);
});

test("deleting the last cluster takes the leader and the relay off Deplo's machine, and the relay's route out of the proxy", async () => {
  const eu = await clusterOf("eu", ["srv_2"]);
  const us = await clusterOf("us", []);
  assert.equal(panelRoute(hosts[SERVER_1].proxy.yaml)?.relay, true);

  await asAdmin(() => deleteCluster(eu.id));
  assert.equal(hosts[SERVER_1].removes, 0, "us still needs them");
  assert.equal(panelRoute(hosts[SERVER_1].proxy.yaml)?.relay, true);

  await asAdmin(() => deleteCluster(us.id));
  assert.deepEqual(await clusterNames(), []);
  assert.equal(hosts[SERVER_1].removes, 1);
  assert.equal(hosts[SERVER_1].status.installed, false);
  assert.ok(!panelRoute(hosts[SERVER_1].proxy.yaml)?.relay, "the route left");
  assert.equal(
    (await activity()).at(-1),
    "user_1: Deleted cluster us",
    "a cluster of one never failed over, and an empty one held nothing",
  );
});

test("a leader on another server is uninstalled with its cluster, unless it leads another", async () => {
  const eu = await clusterOf("eu", ["srv_2"]);
  const us = await clusterOf("us", ["srv_3"]);
  leaderOn("srv_4", {
    status: { ...RUNNING, installed: false, running: false, relay: false },
  });
  await asAdmin(() => moveClusterLeader(eu.id, "srv_4"));
  await asAdmin(() => moveClusterLeader(us.id, "srv_4"));

  await asAdmin(() => deleteCluster(eu.id));
  assert.deepEqual(told.srv_4.forgotten, [eu.id]);
  assert.equal(hosts.srv_4.removes, 0, "it still leads us");

  await asAdmin(() => deleteCluster(us.id));
  assert.deepEqual(told.srv_4.forgotten, [eu.id, us.id]);
  assert.equal(hosts.srv_4.removes, 1);
  // Deplo's own machine stood by for both: it forgot each, then lost its leader with the last one.
  assert.deepEqual(told[SERVER_1].forgotten, [eu.id, us.id]);
  assert.equal(hosts[SERVER_1].removes, 1);
});

test("a cluster is not deleted while a server that still runs work does not answer", async () => {
  await runningApp("web", "srv_3");
  const eu = await clusterOf("eu", ["srv_2", "srv_3"]);
  hosts.srv_3.unreachable = true;
  await assert.rejects(
    asAdmin(() => deleteCluster(eu.id)),
    {
      message:
        "srv_3 does not answer, and 1 App still runs on it. Bring it back online, or empty it, before deleting eu.",
    },
  );
  assert.deepEqual(await clusterNames(), ["eu"]);
  assert.equal((await appRow("web")).clusterId, eu.id);
  assert.deepEqual(hosts.srv_2.memberCalls, [], "nobody was told to leave");
});

test("a member that holds nothing and does not answer never blocks a delete: it is told once it is back", async () => {
  await runningApp("web", "srv_2");
  const eu = await clusterOf("eu", ["srv_2", "srv_3"]);
  hosts.srv_3.unreachable = true;
  await asAdmin(() => deleteCluster(eu.id));
  assert.deepEqual(await clusterNames(), []);
  assert.ok((await server("srv_3")).clusterLeavePendingAt);
  hosts.srv_3.unreachable = false;
  await reconcileLeftMembers();
  assert.deepEqual(hosts.srv_3.memberCalls, [{ member: false, relays: [] }]);
});

test("the confirmation names the asking team's Apps and databases, and only counts another team's", async () => {
  await runningApp("web", "srv_2");
  await runningApp("worker", "srv_3");
  await runningApp("secret-api", "srv_3", TEAM_B);
  await seedDatabase(db(), { id: "db_main", name: "main", serverId: "srv_3" });
  await seedDatabase(db(), {
    id: "db_b",
    name: "ledger",
    serverId: "srv_2",
    teamId: TEAM_B,
  });
  const eu = await clusterOf("eu", ["srv_2", "srv_3"]);
  // web runs on two servers; worker found no room after its server stopped.
  await placed("web", ["srv_2", "srv_3"]);
  await placed("worker", [null]);

  const d = await asAdmin(() => getClusterDeletion(eu.id));
  assert.deepEqual(d, {
    failoverOn: true,
    workloads: [
      {
        kind: "app",
        name: "web",
        serverName: "srv_2",
        stopsOn: ["srv_3"],
        waiting: false,
        // Both are on srv_3 only: the copy of web that stays, on srv_2, no longer finds them by name.
        losesReach: ["main", "worker"],
      },
      {
        kind: "app",
        name: "worker",
        serverName: "srv_3",
        stopsOn: [],
        waiting: true,
        losesReach: [],
      },
      {
        kind: "database",
        name: "main",
        serverName: "srv_3",
        stopsOn: [],
        waiting: false,
        losesReach: [],
      },
    ],
    otherTeams: [{ teamName: "beta", apps: 1, databases: 1 }],
  });
  assert.ok(!JSON.stringify(d).includes("secret-api"));
  assert.ok(!JSON.stringify(d).includes("ledger"));

  for (const as of [asMember, asTeamB])
    await assert.rejects(
      as(() => getClusterDeletion(eu.id)),
      /Only an instance admin can do that/,
    );
});

test("deleting says which Apps lose a name that crossed servers, to each team about its own", async () => {
  await runningApp("web", "srv_2");
  await runningApp("api", "srv_2", TEAM_B);
  await seedDatabase(db(), { id: "db_main", name: "main", serverId: "srv_3" });
  await seedDatabase(db(), {
    id: "db_b",
    name: "ledger",
    serverId: "srv_3",
    teamId: TEAM_B,
  });
  const eu = await clusterOf("eu", ["srv_2", "srv_3"]);

  const d = await asAdmin(() => getClusterDeletion(eu.id));
  assert.deepEqual(
    d.workloads.map((w) => [w.name, w.losesReach]),
    [
      ["web", ["main"]],
      ["main", []],
    ],
  );
  assert.ok(!JSON.stringify(d).includes("ledger"));

  await asAdmin(() => deleteCluster(eu.id));
  assert.equal(
    (await activity()).at(-1),
    "user_1: Deleted cluster eu: this team's 1 App and 1 database stay where they run and no longer fail over. web can no longer reach main by its name: they run on different servers.",
  );
  assert.equal(
    (await activity(TEAM_B)).at(-1),
    "user_1: Deleted cluster eu: this team's 1 App and 1 database stay where they run and no longer fail over. api can no longer reach ledger by its name: they run on different servers.",
  );
});

test("a Postgres database stops being recorded as archiving its change log when its cluster is deleted", async () => {
  await seedDatabase(db(), { id: "db_main", name: "main", serverId: "srv_2" });
  const eu = await clusterOf("eu", ["srv_2", "srv_3"]);
  await db()
    .update(databasesTable)
    .set({ walArchivedAt: "2026-11-01T00:00:00.000Z" })
    .where(eq(databasesTable.id, "db_main"));
  await asAdmin(() => deleteCluster(eu.id));
  assert.equal((await dbRow("db_main")).walArchivedAt, null);
});

test("a cluster is not deleted while the server keeping a standby copy does not answer: the copy would stay there for good", async () => {
  await seedDatabase(db(), { id: "db_main", name: "main", serverId: "srv_2" });
  const eu = await clusterOf("eu", ["srv_2", "srv_3", "srv_4"]);
  await db().insert(workloadPlacements).values({
    kind: "standby",
    workloadId: "db_main",
    replica: 0,
    memberServerId: "srv_4",
    epoch: 1,
    updatedAt: "2026-11-01T00:00:00.000Z",
  });
  hosts.srv_4.unreachable = true;
  await assert.rejects(
    asAdmin(() => deleteCluster(eu.id)),
    {
      message:
        "srv_4 does not answer, and it keeps the standby copy of 1 database. Bring it back online, or turn the standby copy off, before deleting eu.",
    },
  );
  assert.deepEqual(await clusterNames(), ["eu"]);
});

test("an App spread over several members stays on its first one, and its copies on the others are taken down", async () => {
  await runningApp("web", "srv_2");
  const eu = await clusterOf("eu", ["srv_2", "srv_3", "srv_4"]);
  await placed("web", ["srv_2", "srv_3", "srv_3", "srv_4"]);
  for (const id of ["srv_3", "srv_4"])
    hosts[id].extra = { listInstances: async () => [] };

  await asAdmin(() => deleteCluster(eu.id));

  const web = await appRow("web");
  assert.equal(web.serverId, "srv_2");
  assert.equal(web.clusterId, null);
  assert.deepEqual(hosts.srv_2.stack, [], "the first one keeps running");
  assert.deepEqual(hosts.srv_3.stack, ["destroy:web"]);
  assert.deepEqual(hosts.srv_4.stack, ["destroy:web"]);
});

test("a database's failover backup stays as an ordinary schedule when its cluster is deleted", async () => {
  await seedDatabase(db(), { id: "db_main", name: "main", serverId: "srv_2" });
  const eu = await clusterOf("eu", ["srv_2", "srv_3"]);
  const before = await db().select().from(backupsTable);
  assert.deepEqual(
    before.map((b) => `${b.name} ${b.schedule} ${b.enabled}`),
    ["Failover backup */15 * * * * true"],
  );

  await asAdmin(() => deleteCluster(eu.id));
  assert.deepEqual(await db().select().from(backupsTable), before);
});

test("a leader that could not be taken off Deplo's machine with the last cluster goes with the next sweep", async () => {
  const eu = await clusterOf("eu", []);
  await reconcileDissolvedClusters();
  assert.equal(hosts[SERVER_1].removes, 0, "a cluster still needs it");

  hosts[SERVER_1].unreachable = true;
  await asAdmin(() => deleteCluster(eu.id));
  assert.deepEqual(
    await clusterNames(),
    [],
    "the cluster is gone all the same",
  );
  assert.equal(hosts[SERVER_1].removes, 0);

  hosts[SERVER_1].unreachable = false;
  await reconcileDissolvedClusters();
  assert.equal(hosts[SERVER_1].removes, 1);
  assert.equal(hosts[SERVER_1].status.installed, false);
  await reconcileDissolvedClusters();
  assert.equal(hosts[SERVER_1].removes, 1, "nothing left to remove");
});

test("a leader on a server that did not answer at delete is uninstalled once it does", async () => {
  const eu = await clusterOf("eu", ["srv_2"]);
  await clusterOf("us", ["srv_3"]);
  await asAdmin(() => moveClusterLeader(eu.id, "srv_4"));
  hosts.srv_4.unreachable = true;

  await asAdmin(() => deleteCluster(eu.id));
  await reconcileDissolvedClusters();
  assert.equal(hosts.srv_4.removes, 0, "still away");

  hosts.srv_4.unreachable = false;
  await reconcileDissolvedClusters();
  assert.equal(hosts.srv_4.removes, 1);
});

test("the sweep that finishes a dissolved cluster runs with the others and stops for a Deplo move", () => {
  const sweep = readFileSync(
    new URL("../notify/maintenance.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    sweep,
    /settle\("dissolved clusters", reconcileDissolvedClusters\)/,
  );
  const src = readFileSync(
    new URL("./clusters/dissolve.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    src,
    /export async function reconcileDissolvedClusters\(\): Promise<void> \{\n {2}if \(await instanceFrozen\(\)\) return;/,
  );
});

test("a leader that missed the delete forgets the cluster with the next sweep, and keeps the ones that exist", async () => {
  const eu = await clusterOf("eu", ["srv_2"]);
  const us = await clusterOf("us", ["srv_3"]);
  hosts[SERVER_1].unreachable = true;
  await asAdmin(() => deleteCluster(eu.id));
  assert.deepEqual(told[SERVER_1].forgotten, [], "it never heard");

  hosts[SERVER_1].unreachable = false;
  told[SERVER_1].serving = [eu.id, us.id];
  await reconcileDissolvedClusters();
  assert.deepEqual(told[SERVER_1].forgotten, [eu.id]);
  assert.equal(hosts[SERVER_1].removes, 0, "us still needs its leader");
});
