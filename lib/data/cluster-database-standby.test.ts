import { test } from "node:test";
import assert from "node:assert/strict";

import { and, eq } from "drizzle-orm";

import { runWithIdentity, type RequestIdentity } from "../auth/request-context";
import { getCurrentUser } from "../auth/current-user";
import { getActiveTeamId, reachableCapabilities } from "../membership";
import type { GraphQLContext } from "../graphql/context";
import { runGraphql } from "../mcp/execute";
import { MCP_TOOLS } from "../mcp/tools/catalog";
import { seedIdentity, TEAM_A, TEAM_B, USER_1 } from "./identity-test-helpers";
import { users as usersTable } from "../db/schema/control-plane/identity";
import { workloadPlacements } from "../db/schema/control-plane/clusters";
import { databases as databasesTable } from "../db/schema/control-plane/databases";
import type { AgentConnection } from "../infra/agent-client/connection";
import { planClusterForwarding } from "./clusters/forwarders";
import {
  flushStandbySyncs,
  getDatabaseStandby,
  reconcileStandbys,
  setDatabaseStandby,
  standbyPassword,
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
  fp,
  host,
  leader,
  leaderHost,
  main,
  open,
} from "./cluster-database-test-helpers";

databaseLab();

const dec = new TextDecoder();
const enc = new TextEncoder();

interface Exec {
  on: string;
  container: string;
  command: string;
}
let execs: Exec[] = [];
/** What the copy's own check answers on each member. */
let copyState: Record<string, string> = {};

/** The members answer the engine's scripts; the leader places a copy where `place` says, or refuses. */
function lab(place: (exclude: string[]) => Record<string, unknown>) {
  execs = [];
  copyState = {};
  for (const [id, h] of Object.entries(host))
    h.extra = {
      exec: (async (_app, container, command) => {
        execs.push({ on: id, container, command });
        return {
          stdout: container.endsWith("_standby")
            ? (copyState[id] ?? "following")
            : "",
          stderr: "",
          code: 0,
          rawMode: false,
        };
      }) as AgentConnection["exec"],
    };
  const calls = leaderHost.leader;
  leaderHost.leader = (method, payload) => {
    if (method !== "placement.place") return calls(method, payload);
    const body = JSON.parse(dec.decode(payload)) as { exclude?: string[] };
    return enc.encode(JSON.stringify(place(body.exclude ?? [])));
  };
}

const onSrv3 = () => lab(() => ({ member: "srv_3" }));

const row = async () =>
  (
    await db
      .select()
      .from(databasesTable)
      .where(eq(databasesTable.id, "db_main"))
  )[0];

const copyOn = async () =>
  (
    await db
      .select()
      .from(workloadPlacements)
      .where(
        and(
          eq(workloadPlacements.kind, "standby"),
          eq(workloadPlacements.workloadId, "db_main"),
        ),
      )
  ).map((r) => r.memberServerId);

const lastRoster = () =>
  leader.rosters.at(-1) as unknown as {
    placement: { id: string; member: string }[];
    standbys?: { id: string; member: string; slug: string; standby: boolean }[];
  };

test("turning it on places the copy on another server than the database, which follows it through the name it holds", async () => {
  const cluster = await eu();
  await main(cluster.id);
  let asked: string[] = [];
  lab((exclude) => {
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
  lab(() => assert.fail("the leader was asked with nowhere to place"));
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
  lab(() => ({
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
  lab(() => ({
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
  lab(() => ({ member: "srv_2" }));
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
  lab((exclude) => {
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
    .set({ clusterId: cluster.id, type: "redis" })
    .where(eq(databasesTable.id, "db_main"));
  await assert.rejects(
    asAdmin(() => setDatabaseStandby("db_main", true)),
    { message: "A standby copy is available for PostgreSQL databases only." },
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
  lab((exclude) => {
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
  lab(() => ({
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
  lab(() => ({ member: "srv_2" }));
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
  execs = [];

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
  lab((exclude) => {
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
  execs = [];

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

async function runTool(
  identity: RequestIdentity,
  name: string,
  args: Record<string, unknown>,
) {
  const tool = MCP_TOOLS.find((t) => t.name === name)!;
  const ctx = await runWithIdentity(
    identity,
    async (): Promise<GraphQLContext> => ({
      viewer: await getCurrentUser(),
      teamId: await getActiveTeamId(),
      capabilities: await reachableCapabilities(),
      via: "token",
      identity,
    }),
  );
  return runGraphql(tool.query, tool.variables!(args as never), ctx);
}

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
