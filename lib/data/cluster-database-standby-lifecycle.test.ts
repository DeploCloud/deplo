import { test } from "node:test";
import assert from "node:assert/strict";

import { eq } from "drizzle-orm";

import { workloadPlacements } from "../db/schema/control-plane/clusters";
import { databases as databasesTable } from "../db/schema/control-plane/databases";
import { deleteCluster, removeClusterMember } from "./clusters/dissolve";
import { planClusterForwarding } from "./clusters/forwarders";
import {
  flushStandbySyncs,
  getDatabaseStandby,
  reconcileStandbys,
  setDatabaseStandby,
  syncStandby,
} from "./databases/standby";
import { getDatabaseFailover, getFailoverPreview } from "./databases/failover";
import { deleteDatabase } from "./databases/lifecycle";
import {
  relocateClusterDatabase,
  updateDatabase,
} from "./databases/server-move";
import {
  apply,
  asAdmin,
  backedUp,
  databaseLab,
  db,
  deploSaid,
  eu,
  event,
  host,
  main,
  open,
} from "./cluster-database-test-helpers";
import {
  copyOn,
  copyState,
  execs,
  lastRoster,
  onSrv3,
  row,
  standbyLab,
} from "./cluster-database-standby-test-helpers";

// What happens to a standby copy once it exists: a failover promotes it, the switch goes off, or its
// database moves, leaves its cluster or is deleted. Turning it on is in cluster-database-standby.test.ts.

databaseLab();

/** The leader's two events of a failover that promoted the copy on `to`. */
const promoted = (clusterId: string, to = "srv_3") => [
  event(clusterId, "placement", {
    kind: "database",
    workloadId: "db_main",
    members: [to],
    epoch: 1,
  }),
  event(clusterId, "failed_over", {
    kind: "database",
    workloadId: "db_main",
    from: "srv_2",
    to,
    reason: "stopped_answering",
    promoted: true,
  }),
];

test("a failover that promoted the copy says so, restores nothing, and a new copy is made on another server", async () => {
  const cluster = await eu(["srv_2", "srv_3", "srv_4"]);
  await main(cluster.id);
  await backedUp();
  onSrv3();
  await asAdmin(() => setDatabaseStandby("db_main", true));
  standbyLab((exclude) => {
    assert.deepEqual(exclude, ["srv_3"]);
    return { member: "srv_4" };
  });

  await apply(cluster.id, ...promoted(cluster.id));
  await flushStandbySyncs();

  assert.equal((await row()).serverId, "srv_3");
  assert.deepEqual(
    (await deploSaid()).filter((m) => /Promoted|Restored|Keeps/.test(m)),
    [
      "Promoted the standby copy of main on server-3: server-2 stopped answering. No backup was restored.",
      "Keeps a standby copy of main on server-4",
    ],
  );
  // The promoted copy is the database now; the new copy follows it from the third server.
  assert.deepEqual(await copyOn(), ["srv_4"]);
  assert.match(
    host.srv_4.reroutes[0].composeYaml,
    /container_name: db-main_standby\n/,
  );
  assert.equal(execs.find((e) => e.container === "db-main")?.on, "srv_3");
  assert.deepEqual(
    lastRoster().standbys?.map((s) => s.member),
    ["srv_4"],
  );
  // Never the same seed twice: the new server starts from the database as it is now.
  const seeds = [host.srv_3.reroutes[0], host.srv_4.reroutes[0]].map(
    (r) => /DEPLO_STANDBY_SEED=(sby_[A-Za-z0-9_-]+)/.exec(r.composeYaml)![1],
  );
  assert.notEqual(seeds[0], seeds[1]);
});

test("with no other server to take a new copy, the page says there is none right now", async () => {
  const cluster = await eu();
  await main(cluster.id);
  await backedUp();
  onSrv3();
  await asAdmin(() => setDatabaseStandby("db_main", true));
  const before = await asAdmin(() => getDatabaseFailover("db_main"));
  assert.equal(before!.standbyOn, "server-3");
  assert.equal(before!.standbyNote, null);
  standbyLab(() => ({
    refusal: {
      reason: "no_member_online",
      neededMb: 256,
      cluster: cluster.id,
      workload: "db_main",
    },
  }));

  await apply(cluster.id, ...promoted(cluster.id));
  await flushStandbySyncs();

  assert.deepEqual(await copyOn(), []);
  assert.equal((await row()).standby, true);
  const page = await asAdmin(() => getDatabaseFailover("db_main"));
  assert.equal(page!.standbyOn, null);
  assert.equal(
    page!.standbyNote,
    "There is no standby copy right now, so a failover restores the latest backup. Deplo makes a new copy as soon as another server has room.",
  );
  assert.match(page!.loss, /^No backup is scheduled/);
  assert.equal(
    (await asAdmin(() => getDatabaseStandby("db_main")))!.note,
    "There is no standby copy right now. Deplo makes one as soon as another server has room.",
  );
  assert.deepEqual(
    (await deploSaid()).filter((m) => /no standby copy/.test(m)),
    [
      "main has no standby copy right now. No other server in cluster eu is online and ready right now, so a standby copy of main has nowhere to run. Bring a server back or add one.",
    ],
  );
  // The bundle no longer promises a promotion that cannot happen.
  assert.equal((await open()).promote, undefined);
  assert.equal(lastRoster().standbys, undefined);

  // A server comes back: the sweep makes the copy, once.
  standbyLab(() => ({ member: "srv_2" }));
  await reconcileStandbys();
  await reconcileStandbys();
  assert.deepEqual(await copyOn(), ["srv_2"]);
  assert.equal(host.srv_2.reroutes.length, 1);
});

test("the page and the place-on-cluster dialog state about a second of loss while a copy follows", async () => {
  const cluster = await eu();
  await main(cluster.id);
  await backedUp();
  const without = await asAdmin(() => getDatabaseFailover("db_main"));
  assert.match(without!.loss, /^No backup is scheduled/);
  assert.equal(without!.standbyOn, null);
  onSrv3();
  await asAdmin(() => setDatabaseStandby("db_main", true));

  const page = await asAdmin(() => getDatabaseFailover("db_main"));
  assert.equal(
    page!.loss,
    "A failover loses about a second of writes: the standby copy follows every change.",
  );
  assert.equal(
    page!.recovery,
    "Recovery takes about two minutes: the copy takes over and nothing is restored.",
  );
  assert.deepEqual(page!.promises, [
    "Never two writers",
    "A failover promotes the standby copy; a backup is restored only when the copy had stopped following",
  ]);
  const dialog = await asAdmin(() => getFailoverPreview("db_main"));
  assert.equal(dialog!.loss, page!.loss);
  assert.equal(dialog!.recovery, page!.recovery);

  const sw = await asAdmin(() => getDatabaseStandby("db_main"));
  assert.deepEqual(sw, {
    enabled: true,
    unavailable: null,
    cost: "Uses as much memory as the database on a second server and a second copy of its data. Its own server keeps up to 1 GiB more.",
    serverName: "server-3",
    note: "The copy runs on server-3. A failover promotes it.",
  });
});

test("turning it off removes the copy with its data and only the copy, and the database stops keeping changes for one", async () => {
  const cluster = await eu();
  await main(cluster.id);
  onSrv3();
  await asAdmin(() => setDatabaseStandby("db_main", true));
  execs.length = 0;

  await asAdmin(() => setDatabaseStandby("db_main", false));

  assert.equal((await row()).standby, false);
  assert.equal((await row()).standbySeed, null);
  assert.deepEqual(await copyOn(), []);
  assert.deepEqual(
    host.srv_3.stack.filter((s) => s.startsWith("destroy")),
    ["destroy:db-main"],
  );
  assert.deepEqual(host.srv_2.stack, []);
  assert.match(
    execs.find((e) => e.on === "srv_2")!.command,
    /DROP ROLE IF EXISTS deplo_standby/,
  );
  assert.equal(lastRoster().standbys, undefined);
  assert.equal((await open()).promote, undefined);
  assert.deepEqual(
    (await planClusterForwarding(cluster.id)).get("srv_3"),
    undefined,
  );
});

test("a stack of that name that is not a copy is never destroyed", async () => {
  const cluster = await eu();
  await main(cluster.id);
  onSrv3();
  await asAdmin(() => setDatabaseStandby("db_main", true));
  // The copy was promoted while Deplo was away: srv_3 now runs the database itself under the same stack name.
  host.srv_3.stacks["db-main"] =
    "services:\n  db-main:\n    container_name: db-main\n";

  await asAdmin(() => setDatabaseStandby("db_main", false));

  assert.deepEqual(
    host.srv_3.stack.filter((s) => s.startsWith("destroy")),
    [],
  );
  assert.deepEqual(await copyOn(), []);
});

test("a copy that stopped following is made again where it is, and one that follows or is being made is left alone", async () => {
  const cluster = await eu();
  await main(cluster.id);
  onSrv3();
  await asAdmin(() => setDatabaseStandby("db_main", true));
  const first = host.srv_3.reroutes[0].composeYaml;

  for (const state of ["following", "seeding"]) {
    copyState.srv_3 = state;
    await reconcileStandbys();
  }
  assert.equal(host.srv_3.reroutes.length, 1);

  // What changes on the database reaches the copy with its data kept: the same seed.
  const seedOf = (yaml: string) => /DEPLO_STANDBY_SEED=(\S+)/.exec(yaml)![1];
  await db
    .update(databasesTable)
    .set({ resourceMemLimitMb: 512 })
    .where(eq(databasesTable.id, "db_main"));
  await reconcileStandbys();
  await reconcileStandbys();
  assert.equal(host.srv_3.reroutes.length, 2);
  assert.equal(seedOf(host.srv_3.reroutes[1].composeYaml), seedOf(first));
  host.srv_3.reroutes.pop();

  copyState.srv_3 = "behind";
  await reconcileStandbys();
  assert.equal(host.srv_3.reroutes.length, 2);
  // A new seed: the server throws the stale data away and starts from the database as it is now.
  assert.notEqual(host.srv_3.reroutes[1].composeYaml, first);
  assert.deepEqual(await copyOn(), ["srv_3"]);
  assert.deepEqual(
    (await deploSaid()).filter((m) => /standby/.test(m)),
    [
      "Made the standby copy of main on server-3 again: it had stopped following",
    ],
  );
});

test("deleting the database removes its copy from the other server too", async () => {
  const cluster = await eu();
  await main(cluster.id);
  onSrv3();
  await asAdmin(() => setDatabaseStandby("db_main", true));

  await asAdmin(() => deleteDatabase("db_main", { force: true }));

  assert.deepEqual(
    host.srv_3.stack.filter((s) => s.startsWith("destroy")),
    ["destroy:db-main"],
  );
  assert.deepEqual(
    await db
      .select()
      .from(workloadPlacements)
      .where(eq(workloadPlacements.workloadId, "db_main")),
    [],
  );
});

test("a database whose switch is off, or that left its cluster, keeps no copy after the sweep", async () => {
  const cluster = await eu();
  await main(cluster.id);
  onSrv3();
  await asAdmin(() => setDatabaseStandby("db_main", true));
  await db
    .update(databasesTable)
    .set({ clusterId: null })
    .where(eq(databasesTable.id, "db_main"));

  await syncStandby("db_main");

  assert.deepEqual(await copyOn(), []);
  assert.deepEqual(
    host.srv_3.stack.filter((s) => s.startsWith("destroy")),
    ["destroy:db-main"],
  );
});

test("a database moved onto its copy's server loses the copy first, and gets a new one on another server", async () => {
  const cluster = await eu();
  await main(cluster.id);
  onSrv3();
  await asAdmin(() => setDatabaseStandby("db_main", true));
  standbyLab((exclude) => {
    assert.deepEqual(exclude, ["srv_3"]);
    return { member: "srv_2" };
  });

  await relocateClusterDatabase("db_main", cluster, "srv_3", "a test");
  await flushStandbySyncs();

  // The copy's stack is gone from srv_3 before the database's own arrives under the same name.
  const steps = host.srv_3.stack.filter((s) => /^(destroy|reroute):/.test(s));
  assert.deepEqual(steps.slice(0, 3), [
    "reroute:db-main",
    "destroy:db-main",
    "reroute:db-main",
  ]);
  assert.match(
    host.srv_3.reroutes.at(-1)!.composeYaml,
    /container_name: db-main\n/,
  );
  assert.equal((await row()).serverId, "srv_3");
  assert.deepEqual(await copyOn(), ["srv_2"]);
  assert.match(
    host.srv_2.reroutes.at(-1)!.composeYaml,
    /container_name: db-main_standby\n/,
  );
});

test("a database that leaves its cluster keeps no copy and the switch goes off", async () => {
  const cluster = await eu();
  await main(cluster.id);
  onSrv3();
  await asAdmin(() => setDatabaseStandby("db_main", true));
  execs.length = 0;

  await asAdmin(() =>
    updateDatabase("db_main", { exposedPublicly: false, serverId: "srv_4" }),
  );
  await flushStandbySyncs();

  const now = await row();
  assert.equal(now.serverId, "srv_4");
  assert.equal(now.clusterId, null);
  assert.equal(now.standby, false);
  assert.deepEqual(
    await db
      .select()
      .from(workloadPlacements)
      .where(eq(workloadPlacements.workloadId, "db_main")),
    [],
  );
  assert.ok(host.srv_3.stack.includes("destroy:db-main"));
  // Where it runs now it stops keeping changes for a copy.
  assert.match(
    execs.find((e) => e.on === "srv_4")!.command,
    /DROP ROLE IF EXISTS deplo_standby/,
  );
});

test("deleting the cluster takes the copy away with it, and the switch goes off", async () => {
  const cluster = await eu();
  await main(cluster.id);
  onSrv3();
  await asAdmin(() => setDatabaseStandby("db_main", true));
  execs.length = 0;

  await asAdmin(() => deleteCluster(cluster.id));

  const now = await row();
  assert.equal(now.clusterId, null);
  assert.equal(now.serverId, "srv_2");
  assert.equal(now.standby, false);
  assert.deepEqual(
    await db
      .select()
      .from(workloadPlacements)
      .where(eq(workloadPlacements.workloadId, "db_main")),
    [],
  );
  assert.ok(host.srv_3.stack.includes("destroy:db-main"));
  assert.match(
    execs.find((e) => e.on === "srv_2")!.command,
    /DROP ROLE IF EXISTS deplo_standby/,
  );
});

test("a server that holds only a copy leaves its cluster, and the copy is made again on another", async () => {
  const cluster = await eu(["srv_2", "srv_3", "srv_4"]);
  await main(cluster.id);
  onSrv3();
  await asAdmin(() => setDatabaseStandby("db_main", true));
  standbyLab(() => ({ member: "srv_4" }));

  await asAdmin(() => removeClusterMember(cluster.id, "srv_3"));
  await reconcileStandbys();

  assert.deepEqual(await copyOn(), ["srv_4"]);
  assert.ok(host.srv_3.stack.includes("destroy:db-main"));
  assert.equal((await row()).standby, true);
});
