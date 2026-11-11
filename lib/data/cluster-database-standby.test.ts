import { test } from "node:test";
import assert from "node:assert/strict";

import { eq } from "drizzle-orm";

import { runWithIdentity } from "../auth/request-context";
import { runTool } from "../mcp/run-tool-test-helpers";
import { seedIdentity, TEAM_A, TEAM_B, USER_1 } from "./identity-test-helpers";
import { users as usersTable } from "../db/schema/control-plane/identity";
import {
  imageArchitectures,
  workloadPlacements,
} from "../db/schema/control-plane/clusters";
import { databases as databasesTable } from "../db/schema/control-plane/databases";
import { fakeRegistry } from "../registry/registry-test-helpers";
import { planClusterForwarding } from "./clusters/forwarders";
import {
  getDatabaseStandby,
  setDatabaseStandby,
  standbyPassword,
} from "./databases/standby";
import { getDatabaseFailover } from "./databases/failover";
import {
  asAdmin,
  databaseLab,
  db,
  eu,
  fp,
  host,
  leaderHost,
  main,
  open,
} from "./cluster-database-test-helpers";
import {
  copyOn,
  execs,
  lastRoster,
  onSrv3,
  row,
  standbyLab,
} from "./cluster-database-standby-test-helpers";

databaseLab();

const dec = new TextDecoder();

test("turning it on places the copy on another server than the database, which follows it through the name it holds", async () => {
  const cluster = await eu();
  await main(cluster.id);
  let asked: string[] = [];
  standbyLab((exclude) => {
    asked = exclude;
    return { member: "srv_3" };
  });

  await asAdmin(() => setDatabaseStandby("db_main", true));

  // The leader is asked, and never offered the database's own server.
  assert.deepEqual(asked, ["srv_2"]);
  assert.equal((await row()).standby, true);
  assert.deepEqual(await copyOn(), ["srv_3"]);
  assert.equal((await row()).serverId, "srv_2");

  // The database is prepared where it runs; the copy's stack goes to the other server only.
  const prepared = execs.find((e) => e.on === "srv_2")!;
  assert.equal(prepared.container, "db-main");
  assert.match(prepared.command, /ALTER ROLE deplo_standby WITH REPLICATION/);
  assert.equal(host.srv_2.reroutes.length, 0);
  assert.equal(host.srv_3.reroutes.length, 1);
  const sent = host.srv_3.reroutes[0];
  assert.equal(sent.slug, "db-main");
  assert.match(sent.composeYaml, /container_name: db-main_standby\n/);
  assert.match(sent.composeYaml, /pg_basebackup -h db-main -p 5432/);
  assert.doesNotMatch(sent.composeYaml, /^ {2}db-main:/m);

  // The copy's server holds the database's name (so the copy reaches it over the relay), and may serve it once promoted.
  const plan = await planClusterForwarding(cluster.id);
  assert.deepEqual(
    plan.get("srv_3")!.hold.map((h) => h.name),
    ["db-main"],
  );
  assert.deepEqual(
    plan.get("srv_3")!.serve.map((s) => [s.workloadId, s.sourceFingerprints]),
    [["db_main", [fp(2)]]],
  );
  // The database's own server lets the copy's server in.
  assert.deepEqual(
    plan.get("srv_2")!.serve.map((s) => [s.workloadId, s.sourceFingerprints]),
    [["db_main", [fp(3)]]],
  );
  assert.deepEqual(plan.get("srv_2")!.hold, []);
  assert.deepEqual(
    host.srv_3.forwarders.at(-1)!.hold.map((h) => h.name),
    ["db-main"],
  );

  // The leader knows the copy apart from the database, and its bundle says how to promote it.
  const roster = lastRoster();
  assert.deepEqual(
    roster.placement.map((p) => [p.id, p.member]),
    [["db_main", "srv_2"]],
  );
  assert.deepEqual(roster.standbys, [
    {
      kind: "database",
      id: "db_main",
      replica: 0,
      member: "srv_3",
      slug: "db-main",
      singleWriter: false,
      standby: true,
    },
  ]);
  const bundle = await open();
  assert.equal(bundle.promote?.container, "db-main_standby");
  assert.equal(bundle.promote?.user, "postgres");
  assert.match(bundle.promote!.command.join(" "), /pg_ctl promote/);
  assert.match(bundle.stack.composeYaml, /container_name: db-main\n/);

  const [entry] = (
    await db.query.activities.findMany({
      where: (a, { like }) => like(a.message, "Turned on%"),
    })
  ).map((a) => [a.message, a.actor, a.teamId, a.databaseId]);
  assert.deepEqual(entry, [
    "Turned on the standby copy of main, on server-3",
    (
      await db
        .select({ name: usersTable.name })
        .from(usersTable)
        .where(eq(usersTable.id, USER_1))
    )[0].name,
    TEAM_A,
    "db_main",
  ]);
});

test("the copy is only offered servers the database's image runs on", async () => {
  const cluster = await eu(["srv_2", "srv_3", "srv_4"]);
  await main(cluster.id);
  const offered = () =>
    JSON.parse(
      dec.decode(
        leaderHost.calls.findLast((c) => c.method === "placement.place")!
          .payload,
      ),
    ).workload.archs;

  // No registry described the image: the kind of server the database runs on.
  onSrv3();
  await asAdmin(() => setDatabaseStandby("db_main", true));
  assert.deepEqual(offered(), ["amd64"]);

  // The official image is published for both kinds, so the copy may run on either.
  await asAdmin(() => setDatabaseStandby("db_main", false));
  await db.delete(imageArchitectures);
  fakeRegistry({ "library/postgres:16-alpine": ["amd64", "arm64"] });
  await asAdmin(() => setDatabaseStandby("db_main", true));
  assert.deepEqual(offered(), ["amd64", "arm64"]);
});

test("the copy's password is made by Deplo, reaches the servers inside their agent's call, and is nowhere in Deplo's database", async () => {
  const cluster = await eu();
  await main(cluster.id);
  onSrv3();
  await asAdmin(() => setDatabaseStandby("db_main", true));

  const password = standbyPassword("db_main");
  assert.match(password, /^[A-Za-z0-9_-]{40,}$/);
  assert.notEqual(password, standbyPassword("db_other"));
  assert.ok(execs[0].command.includes(password));
  assert.ok(host.srv_3.reroutes[0].composeYaml.includes(password));
  // The engine's own password does not ride along as the copy's.
  assert.doesNotMatch(execs[0].command, /PASSWORD '\\''pw'/);

  const stored = JSON.stringify([
    await db.select().from(databasesTable),
    await db.select().from(workloadPlacements),
    await db.query.activities.findMany(),
    await db.query.failoverBundlePushes.findMany(),
  ]);
  assert.ok(!stored.includes(password), "the password is stored in the clear");
  // And no reader hands it out.
  const shown = JSON.stringify([
    await asAdmin(() => getDatabaseStandby("db_main")),
    await asAdmin(() => getDatabaseFailover("db_main")),
  ]);
  assert.ok(!shown.includes(password));
});

test("a cluster with one server, or no room on another, refuses with a sentence and changes nothing", async () => {
  const solo = await eu(["srv_2"]);
  await main(solo.id);
  standbyLab(() => assert.fail("the leader was asked with nowhere to place"));
  await assert.rejects(
    asAdmin(() => setDatabaseStandby("db_main", true)),
    {
      message:
        "Cluster eu has one server, so a standby copy of main has nowhere to run. Add a server to the cluster.",
    },
  );
  assert.equal((await row()).standby, false);
  assert.deepEqual(await copyOn(), []);
  assert.equal(execs.length, 0);
});

test("no room on any other server refuses with what is missing", async () => {
  const cluster = await eu();
  await main(cluster.id);
  standbyLab(() => ({
    refusal: {
      reason: "no_room",
      neededMb: 256,
      cluster: cluster.id,
      workload: "db_main",
    },
  }));
  await assert.rejects(
    asAdmin(() => setDatabaseStandby("db_main", true)),
    {
      message:
        "No other server in cluster eu has 256 MB free for a standby copy of main. Add a server to it or lower main's memory.",
    },
  );
  standbyLab(() => ({
    refusal: {
      reason: "no_member_online",
      neededMb: 256,
      cluster: cluster.id,
      workload: "db_main",
    },
  }));
  await assert.rejects(
    asAdmin(() => setDatabaseStandby("db_main", true)),
    {
      message:
        "No other server in cluster eu is online and ready right now, so a standby copy of main has nowhere to run. Bring a server back or add one.",
    },
  );
  // A leader that names the database's own server is not believed.
  standbyLab(() => ({ member: "srv_2" }));
  await assert.rejects(
    asAdmin(() => setDatabaseStandby("db_main", true)),
    /too old to place this/,
  );
  assert.equal((await row()).standby, false);
  assert.deepEqual(await copyOn(), []);
  assert.equal(host.srv_3.reroutes.length, 0);
  assert.equal(execs.length, 0);
});

test("a server whose agent cannot hold a copy is never offered to the leader", async () => {
  const cluster = await eu(["srv_2", "srv_3", "srv_4"]);
  await main(cluster.id);
  host.srv_3.capabilities = host.srv_3.capabilities.filter(
    (c) => c !== "cluster.standby",
  );
  let asked: string[] = [];
  standbyLab((exclude) => {
    asked = exclude;
    return { member: "srv_4" };
  });
  await asAdmin(() => setDatabaseStandby("db_main", true));
  assert.deepEqual(asked, ["srv_2", "srv_3"]);
  assert.deepEqual(await copyOn(), ["srv_4"]);
});

test("a database on one server, or of an engine with no row, is refused in words", async () => {
  const cluster = await eu();
  await main(cluster.id);
  onSrv3();
  await db
    .update(databasesTable)
    .set({ clusterId: null })
    .where(eq(databasesTable.id, "db_main"));
  await assert.rejects(
    asAdmin(() => setDatabaseStandby("db_main", true)),
    {
      message:
        "Place main on a cluster first: its standby copy runs on another server of the cluster.",
    },
  );
  await db
    .update(databasesTable)
    .set({ clusterId: cluster.id, type: "clickhouse" })
    .where(eq(databasesTable.id, "db_main"));
  await assert.rejects(
    asAdmin(() => setDatabaseStandby("db_main", true)),
    { message: /^ClickHouse keeps no standby copy: / },
  );
  assert.equal((await row()).standby, false);
});

test("the switch needs configure_databases, and another team's database is not found", async () => {
  const cluster = await eu();
  await main(cluster.id);
  onSrv3();
  // A member of the same team who may do much, but not configure a database.
  await seedIdentity(db, {
    teams: [{ id: "team_c", slug: "team-c" }],
    users: [
      {
        id: "user_m",
        teamId: TEAM_A,
        role: "member",
        capabilities: ["view", "create_databases"],
      },
    ],
  });
  const asMember = <T>(fn: () => Promise<T>) =>
    runWithIdentity({ userId: "user_m", teamId: TEAM_A }, fn);
  await assert.rejects(asMember(() => setDatabaseStandby("db_main", true)));
  await assert.rejects(asMember(() => setDatabaseStandby("db_main", false)));

  // Team B's owner holds the Capability, in its own team only.
  const asB = <T>(fn: () => Promise<T>) =>
    runWithIdentity({ userId: "user_b", teamId: TEAM_B }, fn);
  await assert.rejects(
    asB(() => setDatabaseStandby("db_main", true)),
    /not found/i,
  );
  assert.equal(await asB(() => getDatabaseStandby("db_main")), null);
  assert.equal((await row()).standby, false);
  assert.deepEqual(await copyOn(), []);
  assert.equal(execs.length, 0);
  assert.equal(host.srv_3.reroutes.length, 0);
});

test("GraphQL and MCP turn the copy on, the field gate refuses a member without the Capability, and another team finds nothing", async () => {
  const cluster = await eu();
  await main(cluster.id);
  onSrv3();
  await seedIdentity(db, {
    teams: [{ id: "team_c", slug: "team-c" }],
    users: [
      {
        id: "user_m",
        teamId: TEAM_A,
        role: "member",
        capabilities: ["view", "create_databases"],
      },
    ],
  });
  const args = { databaseId: "db_main", enabled: true };

  const refused = await runTool(
    { userId: "user_m", teamId: TEAM_A },
    "set_database_standby",
    args,
  );
  assert.match(refused.error ?? "", /Not authorized/i);
  const other = await runTool(
    { userId: "user_b", teamId: TEAM_B },
    "set_database_standby",
    args,
  );
  assert.match(other.error ?? "", /not found/i);
  assert.equal(execs.length, 0);
  assert.equal((await row()).standby, false);

  const done = await runTool(
    { userId: USER_1, teamId: TEAM_A },
    "set_database_standby",
    args,
  );
  assert.equal(done.error, undefined, done.error ?? "");
  const out = (
    done.data as {
      setDatabaseStandby: { standby: boolean; standbyServerName: string };
    }
  ).setDatabaseStandby;
  assert.equal(out.standby, true);
  assert.equal(out.standbyServerName, "server-3");
  assert.deepEqual(await copyOn(), ["srv_3"]);
});
