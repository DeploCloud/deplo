import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { runWithIdentity, type RequestIdentity } from "../auth/request-context";
import { getCurrentUser } from "../auth/current-user";
import { getActiveTeamId, reachableCapabilities } from "../membership";
import type { GraphQLContext } from "../graphql/context";
import { runGraphql } from "../mcp/execute";
import { MCP_TOOLS } from "../mcp/tools/catalog";
import { seedIdentity, TEAM_A, TEAM_B, USER_1 } from "./identity-test-helpers";
import {
  seedServer,
  SERVER_1,
  TRUNCATE_PROJECT_GRAPH,
} from "./app-graph-test-helpers";
import { seedServerRow } from "./infra-test-helpers";
import {
  seedBackup,
  seedDatabase,
  seedDestination,
  seedRun,
  settleProvisioning,
  TRUNCATE_BACKUPS,
} from "./backup-test-helpers";
import { activities as activitiesTable } from "../db/schema/control-plane/activity";
import {
  backupDestination as destTable,
  backups as backupsTable,
} from "../db/schema/control-plane/backups";
import { workloadPlacements } from "../db/schema/control-plane/clusters";
import { databases as databasesTable } from "../db/schema/control-plane/databases";
import { servers as serversTable } from "../db/schema/control-plane/servers";
import { __resetReleaseCacheForTests } from "../agent/release";
import { __setClusterPinForTest } from "../infra/agent-client/cluster-host";
import {
  fakeClusterHosts,
  type FakeClusterHost,
} from "../infra/agent-client/cluster-test-helpers";
import { __setAgentConnectorForTest } from "../infra/agent-client/connect";
import { createCluster } from "./clusters/manage";
import { addClusterMember } from "./clusters/members";
import { applyLeaderReport } from "./clusters/placement";
import { getDatabaseFailover, getFailoverPreview } from "./databases/failover";
import { createDatabase } from "./databases/provision";
import { moveDatabaseToCluster, updateDatabase } from "./databases/server-move";
import { restoreBackup } from "./backups/restore";
import { FAILOVER_PROMISES } from "../databases/failover-copy";

let db: TestDb;
let pg: PGlite;
let fleet: ReturnType<typeof fakeClusterHosts>;
let host: Record<string, FakeClusterHost> = {};
let origFetch: typeof fetch;
const origIp = process.env.DEPLO_SERVER_IP;

const SUMS =
  `${"a".repeat(64)}  deplo-cluster-linux-amd64\n` +
  `${"b".repeat(64)}  deplo-cluster-linux-arm64\n`;
const everyone: { allTeams: boolean; teamIds: string[] } = {
  allTeams: true,
  teamIds: [],
};

// 1.2 GiB, restored at 5.12 MiB a second: four minutes.
const BACKUP_BYTES = 1_288_490_189;

// What the leader answers a placement request, as its wire JSON.
let answer: unknown = { member: "srv_2" };
let asked: { cluster: string; workload: Record<string, unknown> }[] = [];

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
});

after(async () => {
  await settleProvisioning(db);
  __resetTestDb();
  await pg.close();
});

beforeEach(async () => {
  await settleProvisioning(db);
  await pg.exec(`${TRUNCATE_BACKUPS}${TRUNCATE_PROJECT_GRAPH}
    truncate table clusters, activities, registration_links, membership_capabilities, memberships, users, teams restart identity cascade;`);
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      { id: "user_b", teamId: TEAM_B, role: "owner", isInstanceAdmin: false },
      {
        id: "user_member",
        teamId: TEAM_A,
        role: "member",
        capabilities: ["view", "create_databases", "configure_databases"],
      },
      {
        id: "user_viewer",
        teamId: TEAM_A,
        role: "member",
        capabilities: ["view"],
      },
    ],
  });
  await seedServer(db);
  process.env.DEPLO_SERVER_IP = "10.0.0.1";
  for (const [i, id] of ["srv_2", "srv_3", "srv_4"].entries()) {
    await seedServerRow(db, {
      id,
      name: id.replace("srv_", "server-"),
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
  host = {};
  for (const id of ["srv_2", "srv_3", "srv_4"]) host[id] = fleet.host(id);
  __setClusterPinForTest({ version: "0.2.0", min: "0.2.0" });
  __resetReleaseCacheForTests();
  origFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(SUMS)) as typeof fetch;
});

afterEach(async () => {
  await settleProvisioning(db);
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
const asViewer = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: "user_viewer", teamId: TEAM_A }, fn);
const asTeamB = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: "user_b", teamId: TEAM_B }, fn);

async function eu(members = ["srv_2", "srv_3"], sharing = everyone) {
  const cluster = await asAdmin(() => createCluster("eu", sharing));
  for (const m of members) await asAdmin(() => addClusterMember(cluster.id, m));
  return cluster;
}

const newDb = (clusterId: string, name = "main") =>
  createDatabase({ name, type: "postgres", version: "16", clusterId });

async function dbRow(id: string) {
  const [r] = await db
    .select()
    .from(databasesTable)
    .where(eq(databasesTable.id, id));
  return r;
}

const schedulesOf = (id: string) =>
  db.select().from(backupsTable).where(eq(backupsTable.databaseId, id));

async function destinationOf(databaseId: string) {
  const [schedule] = await schedulesOf(databaseId);
  const [dest] = await db
    .select()
    .from(destTable)
    .where(eq(destTable.id, schedule.destinationId));
  return dest;
}

test("a database placed on a cluster runs on the member the leader picks", async () => {
  const cluster = await eu();
  const created = await asMember(() => newDb(cluster.id));
  await settleProvisioning(db);

  assert.equal(created.serverId, "srv_2");
  assert.equal(created.clusterId, cluster.id);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].cluster, cluster.id);
  assert.equal(asked[0].workload.kind, "database");
  assert.equal(asked[0].workload.id, created.id);
  assert.equal(asked[0].workload.name, "main");
  const placed = await db
    .select()
    .from(workloadPlacements)
    .where(eq(workloadPlacements.workloadId, created.id));
  assert.deepEqual(
    placed.map((p) => [p.kind, p.replica, p.memberServerId]),
    [["database", 0, "srv_2"]],
  );
  assert.deepEqual(host.srv_2.stack, ["reroute:db-main"]);
  assert.equal((await dbRow(created.id)).status, "running");
});

test("placing on a cluster is refused without create_databases, with both a cluster and a server, and for a cluster of another team", async () => {
  const cluster = await eu(["srv_2", "srv_3"], {
    allTeams: false,
    teamIds: [TEAM_A],
  });

  await assert.rejects(() => asViewer(() => newDb(cluster.id)), /permission/i);
  await assert.rejects(
    () =>
      asMember(() =>
        createDatabase({
          name: "main",
          type: "postgres",
          version: "16",
          clusterId: cluster.id,
          serverId: "srv_4",
        }),
      ),
    /Pick a cluster or a server, not both\./,
  );
  await assert.rejects(
    () => asTeamB(() => newDb(cluster.id)),
    /That cluster isn't available to this team\./,
  );
  assert.equal(asked.length, 0);
  assert.equal((await db.select().from(databasesTable)).length, 0);
});

test("a leader's refusal is the sentence the user reads and nothing is created", async () => {
  const cluster = await eu();
  answer = {
    refusal: {
      reason: "no_room",
      neededMb: 256,
      cluster: cluster.id,
      workload: "x",
    },
  };

  await assert.rejects(
    () => asMember(() => newDb(cluster.id)),
    /^Error: No server in cluster eu has 256 MB free\. Add a server to it or lower main's memory\.$/,
  );
  assert.equal((await db.select().from(databasesTable)).length, 0);
  assert.equal((await db.select().from(backupsTable)).length, 0);
});

test("a server that is a cluster member is still refused as a target", async () => {
  await eu();
  await assert.rejects(
    () =>
      asMember(() =>
        createDatabase({
          name: "main",
          type: "postgres",
          version: "16",
          serverId: "srv_2",
        }),
      ),
    /cluster/i,
  );
});

test("placing gives the database a 15-minute backup on the team's destination", async () => {
  const cluster = await eu();
  await seedDestination(db, { id: "dst_bucket", name: "Bucket" });
  const created = await asMember(() => newDb(cluster.id));

  const schedules = await schedulesOf(created.id);
  assert.equal(schedules.length, 1);
  assert.equal(schedules[0].schedule, "*/15 * * * *");
  assert.equal(schedules[0].enabled, true);
  assert.equal(schedules[0].destinationId, "dst_bucket");
  assert.equal(schedules[0].teamId, TEAM_A);
  assert.equal((await db.select().from(destTable)).length, 1);
  const said = await db
    .select()
    .from(activitiesTable)
    .where(eq(activitiesTable.databaseId, created.id));
  assert.ok(
    said.some(
      (a) =>
        a.actor === "Deplo" &&
        a.message === "Backs up main every 15 minutes to Bucket",
    ),
    said.map((a) => a.message).join(" | "),
  );
});

test("a team destination on the member the database runs on is never used", async () => {
  const cluster = await eu();
  await seedDestination(db, {
    id: "dst_same",
    name: "On server-2",
    kind: "server",
    serverId: "srv_2",
  });
  const created = await asMember(() => newDb(cluster.id));

  const dest = await destinationOf(created.id);
  assert.notEqual(dest.id, "dst_same");
  assert.equal(dest.kind, "server");
  assert.equal(dest.serverId, "srv_3");
});

test("with no team destination the backup goes to a new one on another member", async () => {
  const cluster = await eu();
  const created = await asMember(() => newDb(cluster.id));

  const dest = await destinationOf(created.id);
  assert.equal(dest.teamId, TEAM_A);
  assert.equal(dest.kind, "server");
  assert.equal(dest.serverId, "srv_3");
  assert.equal(dest.name, "server-3");
  assert.ok(dest.ageRecipient);
  assert.ok(dest.ageIdentityEnc);
});

test("with no team destination and one member the backup goes to Deplo's own server", async () => {
  const cluster = await eu(["srv_2"]);
  const created = await asMember(() => newDb(cluster.id));

  const dest = await destinationOf(created.id);
  assert.equal(dest.kind, "server");
  assert.equal(dest.serverId, SERVER_1);
});

test("moving a database onto a cluster copies it to the leader's member and keeps its own schedule", async () => {
  const cluster = await eu();
  await seedDatabase(db, { id: "db_1", name: "main", serverId: "srv_4" });
  await seedDestination(db, { id: "dst_bucket", name: "Bucket" });
  await seedBackup(db, {
    id: "bkp_1",
    databaseId: "db_1",
    destinationId: "dst_bucket",
  });

  await asMember(() => moveDatabaseToCluster("db_1", cluster.id));

  const row = await dbRow("db_1");
  assert.equal(row.serverId, "srv_2");
  assert.equal(row.clusterId, cluster.id);
  assert.equal(asked[0].workload.kind, "database");
  assert.equal(asked[0].workload.id, "db_1");
  const from = host.srv_4.stack;
  const to = host.srv_2.stack;
  assert.ok(from.includes("export:deplo-db-main_db-main-data"), from.join());
  assert.ok(to.includes("import:deplo-db-main_db-main-data"), to.join());
  assert.equal(from.at(-1), "destroy:db-main");
  assert.equal(to.at(-1), "start:db-main");
  const placed = await db
    .select()
    .from(workloadPlacements)
    .where(eq(workloadPlacements.workloadId, "db_1"));
  assert.equal(placed[0].memberServerId, "srv_2");
  assert.deepEqual(
    (await schedulesOf("db_1")).map((s) => s.id),
    ["bkp_1"],
  );
});

test("moving onto a cluster creates the 15-minute backup when the database has none", async () => {
  const cluster = await eu();
  await seedDatabase(db, { id: "db_1", name: "main", serverId: "srv_4" });

  await asMember(() => moveDatabaseToCluster("db_1", cluster.id));

  const schedules = await schedulesOf("db_1");
  assert.equal(schedules.length, 1);
  assert.equal(schedules[0].schedule, "*/15 * * * *");
  assert.equal((await destinationOf("db_1")).serverId, "srv_3");
});

test("moving onto a cluster is refused across teams, without the Capability, and when the leader says no", async () => {
  const cluster = await eu(["srv_2", "srv_3"], {
    allTeams: false,
    teamIds: [TEAM_A],
  });
  await seedDatabase(db, { id: "db_1", name: "main", serverId: "srv_4" });
  await seedDatabase(db, {
    id: "db_b",
    name: "theirs",
    serverId: "srv_4",
    teamId: TEAM_B,
  });

  await assert.rejects(
    () => asViewer(() => moveDatabaseToCluster("db_1", cluster.id)),
    /permission/i,
  );
  await assert.rejects(
    () => asTeamB(() => moveDatabaseToCluster("db_b", cluster.id)),
    /That cluster isn't available to this team\./,
  );
  await assert.rejects(
    () => asMember(() => moveDatabaseToCluster("db_b", cluster.id)),
    /Not found/,
  );
  answer = {
    refusal: {
      reason: "no_member_online",
      neededMb: 0,
      cluster: cluster.id,
      workload: "x",
    },
  };
  await assert.rejects(
    () => asMember(() => moveDatabaseToCluster("db_1", cluster.id)),
    /No server in cluster eu is online and ready right now, so main has nowhere to run\./,
  );
  assert.equal((await dbRow("db_1")).serverId, "srv_4");
  assert.equal((await dbRow("db_1")).clusterId, null);
  assert.deepEqual(host.srv_4.stack, []);
  assert.equal((await db.select().from(backupsTable)).length, 0);
});

test("moving a database off its cluster drops its placement", async () => {
  const cluster = await eu();
  const created = await asMember(() => newDb(cluster.id));
  await settleProvisioning(db);

  await asMember(() =>
    updateDatabase(created.id, { exposedPublicly: false, serverId: "srv_4" }),
  );

  const row = await dbRow(created.id);
  assert.equal(row.serverId, "srv_4");
  assert.equal(row.clusterId, null);
  assert.equal(
    (
      await db
        .select()
        .from(workloadPlacements)
        .where(eq(workloadPlacements.workloadId, created.id))
    ).length,
    0,
  );
});

test("the page warns once a failover puts the database on its destination's server", async () => {
  const cluster = await eu();
  const created = await asMember(() => newDb(cluster.id));
  await settleProvisioning(db);

  const before = await asMember(() => getDatabaseFailover(created.id));
  assert.equal(before?.cluster, "eu");
  assert.equal(before?.destination, "server-3");
  assert.equal(before?.warning, null);

  await applyLeaderReport({
    clusterId: cluster.id,
    kind: "database",
    workloadId: created.id,
    members: ["srv_3"],
    epoch: 2,
  });

  const after = await asMember(() => getDatabaseFailover(created.id));
  assert.equal(
    after?.warning,
    "main now runs on server-3, the server its backups are kept on. If server-3 stops, the backups go with it. Pick another destination for its backup.",
  );
});

test("the database page states loss and recovery, from the last backup and the last measured restore", async () => {
  const cluster = await eu();
  await seedDestination(db, { id: "dst_bucket", name: "Bucket" });
  const created = await asMember(() => newDb(cluster.id));
  await settleProvisioning(db);

  const fresh = await asMember(() => getDatabaseFailover(created.id));
  assert.deepEqual(fresh?.promises, [
    "Never two writers",
    "A failover restores the latest backup, and says how old it was",
  ]);
  assert.equal(
    fresh?.loss,
    "A failover can lose up to 15 minutes of writes: everything since the last backup.",
  );
  assert.equal(fresh?.recovery, "Recovery takes a few minutes.");

  await seedRun(db, {
    id: "run_1",
    destinationId: "dst_bucket",
    databaseId: created.id,
    status: "success",
    sizeBytes: BACKUP_BYTES,
  });
  const unmeasured = await asMember(() => getDatabaseFailover(created.id));
  assert.equal(unmeasured?.recovery, "Recovery takes a few minutes.");

  await db
    .update(databasesTable)
    .set({ restoreBytesPerSec: 5_368_709 })
    .where(eq(databasesTable.id, created.id));
  const measured = await asMember(() => getDatabaseFailover(created.id));
  assert.equal(
    measured?.recovery,
    "Recovery takes about 4 minutes: the last backup is 1.2 GiB.",
  );
});

test("a database on one server has no failover copy, and another team's reads nothing", async () => {
  const cluster = await eu();
  await seedDatabase(db, { id: "db_1", name: "main", serverId: "srv_4" });
  const created = await asMember(() => newDb(cluster.id, "clustered"));
  await settleProvisioning(db);

  assert.equal(await asMember(() => getDatabaseFailover("db_1")), null);
  assert.equal(await asTeamB(() => getDatabaseFailover(created.id)), null);
});

test("a schedule that is switched off says there is nothing to restore", async () => {
  const cluster = await eu();
  const created = await asMember(() => newDb(cluster.id));
  await settleProvisioning(db);
  await db
    .update(backupsTable)
    .set({ enabled: false })
    .where(eq(backupsTable.databaseId, created.id));

  const facts = await asMember(() => getDatabaseFailover(created.id));
  assert.equal(
    facts?.loss,
    "No backup is scheduled, so a failover has nothing recent to restore.",
  );
});

test("restoring a database measures the speed the recovery copy uses", async () => {
  await seedDatabase(db, { id: "db_1", name: "main" });
  await seedDestination(db, { id: "dst_bucket", name: "Bucket" });
  await seedRun(db, {
    id: "run_1",
    destinationId: "dst_bucket",
    databaseId: "db_1",
    status: "success",
    sizeBytes: 4_000_000,
  });
  __setAgentConnectorForTest(
    async () =>
      ({
        hello: async () => ({
          capabilities: ["backup", "backup-encrypt-s3", "backup-s3-args"],
        }),
        restore: async function* () {
          yield { result: { ok: true, error: "" } };
        },
        close: () => {},
      }) as never,
  );

  await asAdmin(() => restoreBackup("run_1"));

  assert.ok(((await dbRow("db_1")).restoreBytesPerSec ?? 0) > 0);
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

test("GraphQL and MCP place a database on a cluster, and the field gate refuses a viewer", async () => {
  const cluster = await eu();
  const member = { userId: "user_member", teamId: TEAM_A };
  const viewer = { userId: "user_viewer", teamId: TEAM_A };

  const refused = await runTool(viewer, "create_database", {
    name: "main",
    type: "postgres",
    version: "16",
    clusterId: cluster.id,
  });
  assert.match(refused.error ?? "", /Not authorized/i);
  assert.equal(asked.length, 0);

  const made = await runTool(member, "create_database", {
    name: "main",
    type: "postgres",
    version: "16",
    clusterId: cluster.id,
  });
  assert.equal(made.error, undefined, made.error ?? "");
  const created = (
    made.data as { createDatabase: { id: string; clusterId: string } }
  ).createDatabase;
  assert.equal(created.clusterId, cluster.id);
  await settleProvisioning(db);

  await seedDatabase(db, { id: "db_1", name: "other", serverId: "srv_4" });
  const blocked = await runTool(viewer, "move_database_to_cluster", {
    databaseId: "db_1",
    clusterId: cluster.id,
  });
  assert.match(blocked.error ?? "", /Not authorized/i);
  const moved = await runTool(member, "move_database_to_cluster", {
    databaseId: "db_1",
    clusterId: cluster.id,
  });
  assert.equal(moved.error, undefined, moved.error ?? "");
  assert.equal(
    (moved.data as { moveDatabaseToCluster: { clusterId: string } })
      .moveDatabaseToCluster.clusterId,
    cluster.id,
  );
  assert.equal((await dbRow("db_1")).clusterId, cluster.id);
});

test("the place-on-cluster dialog states what the database would rely on", async () => {
  await seedDatabase(db, { id: "db_1", name: "main", serverId: "srv_4" });
  await seedDatabase(db, { id: "db_2", name: "nightly", serverId: "srv_4" });
  await seedDestination(db, { id: "dst_bucket", name: "Bucket" });
  await seedBackup(db, {
    id: "bkp_2",
    databaseId: "db_2",
    destinationId: "dst_bucket",
  });

  const fresh = await asMember(() => getFailoverPreview("db_1"));
  assert.deepEqual(fresh, {
    promises: [
      "Never two writers",
      "A failover restores the latest backup, and says how old it was",
    ],
    loss: "A failover can lose up to 15 minutes of writes: everything since the last backup.",
    recovery: "Recovery takes a few minutes.",
  });
  // Its own daily schedule is kept, so that is what a failover would restore from.
  const nightly = await asMember(() => getFailoverPreview("db_2"));
  assert.equal(
    nightly?.loss,
    "A failover can lose up to 24 hours of writes: everything since the last backup.",
  );
  assert.equal(await asTeamB(() => getFailoverPreview("db_1")), null);
});

test("the two promises are the spec's words", () => {
  assert.deepEqual(
    [...FAILOVER_PROMISES],
    [
      "Never two writers",
      "A failover restores the latest backup, and says how old it was",
    ],
  );
});
