import { test } from "node:test";
import assert from "node:assert/strict";

import { eq } from "drizzle-orm";

import { runWithIdentity } from "../auth/request-context";
import { TEAM_B } from "./identity-test-helpers";
import { clusterMembers } from "../db/schema/control-plane/clusters";
import { databases as databasesTable } from "../db/schema/control-plane/databases";
import type { DatabaseType } from "../types/database";
import { removeClusterMember } from "./clusters/dissolve";
import { addClusterMember } from "./clusters/members";
import {
  flushStandbySyncs,
  getDatabaseStandby,
  reconcileStandbys,
  setDatabaseStandby,
} from "./databases/standby";
import { getDatabaseFailover } from "./databases/failover";
import {
  asAdmin,
  databaseLab,
  db,
  deploSaid,
  eu,
  host,
  main,
  open,
} from "./cluster-database-test-helpers";
import {
  copyOn,
  copyState,
  execs,
  row,
  standbyLab,
} from "./cluster-database-standby-test-helpers";

// The standby copy of every engine but PostgreSQL (#219); PostgreSQL's own is in cluster-database-standby.test.ts.

databaseLab();

let asked = 0;

/** The members answer the engine's scripts, and the leader places a copy on `member`. */
function lab(member = "srv_3") {
  asked = 0;
  standbyLab(() => {
    asked++;
    return { member };
  });
}

const PORTS: Record<DatabaseType, number> = {
  postgres: 5432,
  mysql: 3306,
  mariadb: 3306,
  redis: 6379,
  mongodb: 27017,
  clickhouse: 8123,
};

/** "main" as a database of another engine, running on srv_2 of the cluster. */
async function engineDb(clusterId: string, type: DatabaseType, version = "99") {
  await main(clusterId);
  await db
    .update(databasesTable)
    .set({
      type,
      version,
      port: PORTS[type],
      username: type === "redis" ? "default" : "app",
    })
    .where(eq(databasesTable.id, "db_main"));
}

/** Everything Deplo itself had a server run or start. */
const sentToServers = () => [
  ...execs.map((e) => e.command),
  ...Object.values(host).flatMap((h) => [
    ...h.reroutes.map((r) => r.composeYaml),
    ...h.deploys.map((d) => d.composeYaml),
  ]),
];

const ENGINES = {
  mysql: {
    prepared: /CREATE USER IF NOT EXISTS/,
    copy: /mysqld --server-id=2 --relay-log=deplo-relay/,
    promotion: "RESET REPLICA ALL",
    cost: "Uses as much memory as the database on a second server and a second copy of its data.",
  },
  mariadb: {
    prepared: /CREATE USER IF NOT EXISTS/,
    copy: /mariadbd --server-id=2 --relay-log=deplo-relay/,
    promotion: "RESET REPLICA ALL",
    cost: "Uses as much memory as the database on a second server and a second copy of its data. Its own server keeps up to 1 GiB more. Turning it on or off restarts the database.",
  },
  redis: {
    prepared: /ACL SETUSER deplo_standby reset on/,
    copy: /--replicaof db-main 6379 --masteruser deplo_standby/,
    promotion: "REPLICAOF NO ONE",
    cost: "Uses as much memory as the database on a second server and a second copy of its data. Its own server uses up to 64 MB more memory.",
  },
  mongodb: {
    prepared: /priority: 0, votes: 0, hidden: true/,
    copy: /mongod --replSet rs0 --keyFile/,
    promotion: "had not followed its database for 15 minutes",
    cost: "Uses as much memory as the database on a second server and a second copy of its data.",
  },
} as const;

for (const [type, e] of Object.entries(ENGINES) as [
  keyof typeof ENGINES,
  (typeof ENGINES)[keyof typeof ENGINES],
][])
  test(`${type}: the copy follows from another server, and its promotion goes to the leader alone: Deplo never runs it`, async () => {
    const cluster = await eu(["srv_2", "srv_3", "srv_4"]);
    await engineDb(cluster.id, type);
    lab();

    await asAdmin(() => setDatabaseStandby("db_main", true));

    assert.equal((await row()).standby, true);
    assert.deepEqual(await copyOn(), ["srv_3"]);
    const prepared = execs.filter((x) => x.on === "srv_2");
    assert.equal(prepared.length, 1);
    assert.equal(prepared[0].container, "db-main");
    assert.match(prepared[0].command, e.prepared);
    assert.equal(host.srv_3.reroutes.length, 1);
    const copy = host.srv_3.reroutes[0].composeYaml;
    assert.match(copy, /container_name: db-main_standby\n/);
    assert.match(copy, e.copy);
    assert.doesNotMatch(copy, /^ {2}db-main:/m);

    // The leader holds how to promote, sealed with the database's own stack; it orders it after the old server fenced itself.
    const bundle = await open();
    assert.equal(bundle.promote?.container, "db-main_standby");
    assert.equal(bundle.promote?.user, "");
    assert.deepEqual(bundle.promote?.command.slice(0, 2), ["sh", "-c"]);
    assert.ok(bundle.promote!.command[2].includes(e.promotion));
    assert.match(bundle.stack.composeYaml, /container_name: db-main\n/);

    // Nothing Deplo has a server run or start holds the promotion, now or while it keeps the copy.
    for (const state of ["following", "waiting", "seeding"]) {
      copyState.srv_3 = state;
      await reconcileStandbys();
    }
    for (const sent of sentToServers())
      assert.ok(
        !sent.includes(e.promotion),
        `Deplo sent the promotion: ${sent}`,
      );
    assert.equal(host.srv_3.reroutes.length, 1);

    // The page counts on the copy, and the switch states this engine's cost.
    const page = await asAdmin(() => getDatabaseFailover("db_main"));
    assert.equal(page!.standbyOn, "server-3");
    assert.equal(
      page!.loss,
      "A failover loses about a second of writes: the standby copy follows every change.",
    );
    const sw = await asAdmin(() => getDatabaseStandby("db_main"));
    assert.equal(sw!.cost, e.cost);
    assert.equal(
      sw!.note,
      "The copy runs on server-3. A failover promotes it.",
    );
  });

test("a copy that waits for its database has the database prepared again, and keeps its data", async () => {
  const cluster = await eu();
  await engineDb(cluster.id, "redis");
  lab();
  await asAdmin(() => setDatabaseStandby("db_main", true));
  execs.length = 0;

  copyState.srv_3 = "following";
  await reconcileStandbys();
  assert.deepEqual(
    execs.map((x) => x.container),
    ["db-main_standby"],
  );

  // A Redis that restarted has forgotten the copy's login: nothing else lets the copy back in.
  copyState.srv_3 = "waiting";
  await reconcileStandbys();
  const again = execs.filter((x) => x.on === "srv_2");
  assert.equal(again.length, 1);
  assert.match(again[0].command, /ACL SETUSER deplo_standby reset on/);
  assert.equal(host.srv_3.reroutes.length, 1);
  assert.deepEqual(
    (await deploSaid()).filter((m) => /standby/.test(m)),
    [],
  );
});

test("a MariaDB database is restarted once with its binary log before the copy is made, and once more when the copy goes", async () => {
  const cluster = await eu();
  await engineDb(cluster.id, "mariadb");
  lab();

  await asAdmin(() => setDatabaseStandby("db_main", true));

  assert.equal(host.srv_2.reroutes.length, 1);
  assert.match(
    host.srv_2.reroutes[0].composeYaml,
    /command: \["--log-bin=deplo-binlog","--server-id=1",/,
  );
  assert.match(host.srv_2.reroutes[0].composeYaml, /container_name: db-main\n/);
  // Prepared only once it runs with the log a copy follows.
  assert.deepEqual(execs.find((x) => x.on === "srv_2")!.after, [
    "reroute:db-main",
  ]);
  // What a failover starts on the copy's server keeps the log, so the next copy can follow it.
  assert.match((await open()).stack.composeYaml, /--log-bin=deplo-binlog/);

  execs.length = 0;
  await asAdmin(() => setDatabaseStandby("db_main", false));

  const retired = execs.find((x) => x.on === "srv_2")!;
  assert.match(retired.command, /RESET MASTER/);
  assert.match(retired.command, /DROP USER IF EXISTS/);
  assert.equal(host.srv_2.reroutes.length, 2);
  assert.doesNotMatch(host.srv_2.reroutes[1].composeYaml, /log-bin/);
  assert.doesNotMatch((await open()).stack.composeYaml, /log-bin/);
});

for (const type of ["mysql", "redis", "mongodb"] as const)
  test(`${type}: the database is not restarted for its copy`, async () => {
    const cluster = await eu(["srv_2", "srv_3", "srv_4"]);
    await engineDb(cluster.id, type);
    lab();
    await asAdmin(() => setDatabaseStandby("db_main", true));
    await asAdmin(() => setDatabaseStandby("db_main", false));
    assert.deepEqual(host.srv_2.stack, []);
  });

/** Another team's owner, who holds the Capability in its own team, learns nothing: not even why it is refused. */
async function strangerLearnsNothing() {
  const asB = <T>(fn: () => Promise<T>) =>
    runWithIdentity({ userId: "user_b", teamId: TEAM_B }, fn);
  await assert.rejects(
    asB(() => setDatabaseStandby("db_main", true)),
    /not found/i,
  );
  assert.equal(await asB(() => getDatabaseStandby("db_main")), null);
  assert.equal(await asB(() => getDatabaseFailover("db_main")), null);
}

const THREE =
  "Deplo keeps a standby copy of a MongoDB database only on a cluster of 3 servers or more. Cluster eu has 2: add a server to it.";

test("MongoDB under three servers: the switch is refused in words before anything is asked or written, and the page says so", async () => {
  const cluster = await eu();
  await engineDb(cluster.id, "mongodb");
  lab();

  await assert.rejects(
    asAdmin(() => setDatabaseStandby("db_main", true)),
    { message: THREE },
  );

  assert.equal((await row()).standby, false);
  assert.deepEqual(await copyOn(), []);
  assert.equal(asked, 0);
  assert.equal(execs.length, 0);
  assert.equal(host.srv_3.reroutes.length, 0);
  const sw = await asAdmin(() => getDatabaseStandby("db_main"));
  assert.equal(sw!.enabled, false);
  assert.equal(sw!.unavailable, THREE);

  await strangerLearnsNothing();

  // The same cluster keeps a copy of every other engine: the rule is MongoDB's.
  await db
    .update(databasesTable)
    .set({ type: "redis", port: 6379 })
    .where(eq(databasesTable.id, "db_main"));
  assert.equal(
    (await asAdmin(() => getDatabaseStandby("db_main")))!.unavailable,
    null,
  );
});

test("MongoDB on a cluster that drops to two servers: the copy is retired, the switch stays on, the page says why, and a third server brings it back", async () => {
  const cluster = await eu(["srv_2", "srv_3", "srv_4"]);
  await engineDb(cluster.id, "mongodb");
  lab();
  await asAdmin(() => setDatabaseStandby("db_main", true));
  assert.ok((await open()).promote);

  await asAdmin(() => removeClusterMember(cluster.id, "srv_4"));
  await flushStandbySyncs();

  // Gone with its data, and no longer something a failover could promote.
  assert.deepEqual(await copyOn(), []);
  assert.deepEqual(
    host.srv_3.stack.filter((s) => s.startsWith("destroy")),
    ["destroy:db-main"],
  );
  assert.equal((await open()).promote, undefined);
  assert.equal((await row()).standby, true);
  assert.equal(asked, 1);

  const sw = await asAdmin(() => getDatabaseStandby("db_main"));
  assert.equal(sw!.enabled, true);
  assert.equal(sw!.serverName, null);
  assert.equal(sw!.note, `There is no standby copy right now. ${THREE}`);
  const page = await asAdmin(() => getDatabaseFailover("db_main"));
  assert.equal(page!.standbyOn, null);
  assert.equal(
    page!.standbyNote,
    `There is no standby copy right now, so a failover restores the latest backup. ${THREE}`,
  );
  assert.deepEqual(page!.promises, [
    "Never two writers",
    "A failover restores the latest backup, and says how old it was",
  ]);
  assert.deepEqual(
    (await deploSaid()).filter((m) => /standby/.test(m)),
    [`main has no standby copy right now. ${THREE}`],
  );

  // Said once, however often the sweep comes by.
  await reconcileStandbys();
  assert.equal((await deploSaid()).filter((m) => /standby/.test(m)).length, 1);

  await asAdmin(() => addClusterMember(cluster.id, "srv_4"));
  await reconcileStandbys();
  assert.deepEqual(await copyOn(), ["srv_3"]);
  assert.ok((await open()).promote);
  assert.equal(
    (await deploSaid()).at(-1),
    "Keeps a standby copy of main on server-3",
  );
});

test("a bundle pushed between the server leaving and the copy going already holds no promotion", async () => {
  const cluster = await eu(["srv_2", "srv_3", "srv_4"]);
  await engineDb(cluster.id, "mongodb");
  lab();
  await asAdmin(() => setDatabaseStandby("db_main", true));
  // The roster lost a server and nothing has looked at the copy yet.
  await db.delete(clusterMembers).where(eq(clusterMembers.serverId, "srv_4"));
  const { pushDatabaseBundle } = await import("./clusters/database-bundles");
  await pushDatabaseBundle("db_main");
  assert.deepEqual(await copyOn(), ["srv_3"]);
  assert.equal((await open()).promote, undefined);
});

const NEVER =
  "ClickHouse keeps no standby copy: it copies data table by table through a coordination service Deplo does not run. A failover restores the latest backup.";

test("ClickHouse on a cluster shows why it keeps no standby copy, and the switch is refused with the same words", async () => {
  const cluster = await eu(["srv_2", "srv_3", "srv_4"]);
  await engineDb(cluster.id, "clickhouse", "25.8");
  lab();

  const sw = await asAdmin(() => getDatabaseStandby("db_main"));
  assert.equal(sw!.enabled, false);
  assert.equal(sw!.unavailable, NEVER);
  await assert.rejects(
    asAdmin(() => setDatabaseStandby("db_main", true)),
    { message: NEVER },
  );
  await strangerLearnsNothing();
  assert.equal((await row()).standby, false);
  assert.equal(asked, 0);
  assert.equal(execs.length, 0);
});

test("an engine older than its copy needs is refused with the version it needs", async () => {
  const cluster = await eu();
  await engineDb(cluster.id, "mariadb", "10.11");
  lab();
  await assert.rejects(
    asAdmin(() => setDatabaseStandby("db_main", true)),
    { message: "A standby copy needs MariaDB 11.4 or newer. main runs 10.11." },
  );
  assert.equal(
    (await asAdmin(() => getDatabaseStandby("db_main")))!.unavailable,
    "A standby copy needs MariaDB 11.4 or newer. main runs 10.11.",
  );
  await strangerLearnsNothing();
  assert.equal((await row()).standby, false);
  assert.equal(asked, 0);
  assert.deepEqual(host.srv_2.stack, []);
});
