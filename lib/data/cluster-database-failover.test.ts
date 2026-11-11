import { test } from "node:test";
import assert from "node:assert/strict";

import { eq } from "drizzle-orm";

import { runWithIdentity } from "../auth/request-context";
import { runTool } from "../mcp/run-tool-test-helpers";
import { TEAM_A, TEAM_B, USER_1 } from "./identity-test-helpers";
import { getDatabaseMetricsMarkers } from "./metrics-markers";
import { seedDestination } from "./backup-test-helpers";
import { activities as activitiesTable } from "../db/schema/control-plane/activity";
import { workloadPlacements } from "../db/schema/control-plane/clusters";
import { databases as databasesTable } from "../db/schema/control-plane/databases";
import { decryptSecretOrThrow } from "../crypto";
import { pushDatabaseBundle } from "./clusters/database-bundles";
import { createCluster } from "./clusters/manage";
import { addClusterMember } from "./clusters/members";
import { reconcileCluster } from "./clusters/watch";
import {
  TODAY_1415,
  apply,
  asAdmin,
  backedUp,
  cannot,
  databaseLab,
  db,
  deploSaid,
  eu,
  event,
  failedOver,
  fp,
  last,
  leader,
  main,
  movedOrRestored,
  open,
  web,
} from "./cluster-database-test-helpers";

databaseLab();

test("a database's failover moves its placement and server_id and says which backup was restored, by Deplo, in the database's own team", async () => {
  const cluster = await eu();
  // Team B's database on a shared cluster: the entry must not land on the oldest team.
  await main(cluster.id, TEAM_B);
  await backedUp({ startedAt: TODAY_1415 }, TEAM_B);

  await apply(cluster.id, ...failedOver(cluster.id));

  const [row] = await db
    .select()
    .from(databasesTable)
    .where(eq(databasesTable.id, "db_main"));
  assert.equal(row.serverId, "srv_3");
  assert.equal(row.clusterId, cluster.id);
  const placed = await db
    .select()
    .from(workloadPlacements)
    .where(eq(workloadPlacements.workloadId, "db_main"));
  assert.deepEqual(
    placed.map((p) => p.memberServerId),
    ["srv_3"],
  );
  assert.deepEqual(
    (await deploSaid(TEAM_B)).filter((m) => /^Restored /.test(m)),
    ["Restored main on server-3 from the backup of 14:15"],
  );
  assert.deepEqual(
    (await deploSaid(TEAM_A)).filter((m) => /Restored|main/.test(m)),
    [],
  );
  const [entry] = (await db.select().from(activitiesTable)).filter((a) =>
    /^Restored /.test(a.message),
  );
  assert.equal(entry.databaseId, "db_main");
  assert.equal(entry.type, "database");
});

test("a failover event naming another cluster's or an unknown database writes nothing", async () => {
  const cluster = await eu();
  const other = await asAdmin(() =>
    createCluster("us", { allTeams: true, teamIds: [] }),
  );
  await asAdmin(() => addClusterMember(other.id, "srv_4"));
  await main(cluster.id);
  await backedUp();

  // The other cluster's leader claims this database.
  await apply(other.id, ...failedOver(other.id, "srv_4"));
  await apply(
    cluster.id,
    event(cluster.id, "failed_over", {
      kind: "database",
      workloadId: "db_missing",
      from: "srv_2",
      to: "srv_3",
      reason: "stopped_answering",
    }),
  );

  const [row] = await db
    .select()
    .from(databasesTable)
    .where(eq(databasesTable.id, "db_main"));
  assert.equal(row.serverId, "srv_2");
  assert.deepEqual(
    [...(await deploSaid(TEAM_A)), ...(await deploSaid(TEAM_B))].filter((m) =>
      /^Restored /.test(m),
    ),
    [],
  );
});

test("in one failover the database's entry comes before the App's", async () => {
  const cluster = await eu();
  await main(cluster.id);
  await backedUp({ startedAt: TODAY_1415 });
  await web(cluster.id, "srv_2");

  await apply(
    cluster.id,
    ...failedOver(cluster.id),
    event(cluster.id, "placement", {
      kind: "app",
      workloadId: "prj_web",
      members: ["srv_3"],
      epoch: 1,
    }),
    event(cluster.id, "failed_over", {
      kind: "app",
      workloadId: "prj_web",
      from: "srv_2",
      to: "srv_3",
      reason: "stopped_answering",
    }),
  );

  assert.deepEqual(await movedOrRestored(), [
    "Restored main on server-3 from the backup of 14:15",
    "Moved web to server-3: server-2 stopped answering",
  ]);
});

test("a failover Deplo missed is read back from the leader in the order it happened, backup included", async () => {
  const cluster = await eu();
  await main(cluster.id);
  await backedUp({ startedAt: TODAY_1415 });
  await web(cluster.id, "srv_2");
  const entry = (kind: string, id: string, slug: string) => ({
    kind,
    id,
    replica: 0,
    member: "srv_3",
    slug,
    singleWriter: kind === "database",
  });
  const move = { from: "srv_2", reason: "stopped_answering" };
  // The leader lists its moves by workload, the App first; it moved the database first (the lower sequence).
  leader.snapshot = {
    head: 9,
    clusters: {
      [cluster.id]: {
        epoch: 1,
        superseded: false,
        members: [
          { id: "srv_2", state: "fenced" },
          { id: "srv_3", state: "ok" },
        ],
        placement: [
          entry("app", "prj_web", "web"),
          entry("database", "db_main", "db-main"),
        ],
        moves: [
          { ...entry("app", "prj_web", "web"), ...move, seq: 6 },
          {
            ...entry("database", "db_main", "db-main"),
            ...move,
            seq: 4,
            backupId: "brun_1",
            backupAt: TODAY_1415,
          },
        ],
      },
    },
  };

  await reconcileCluster(cluster.id, { after: 0, before: 10 });

  assert.deepEqual(await movedOrRestored(), [
    "Restored main on server-3 from the backup of 14:15",
    "Moved web to server-3: server-2 stopped answering",
  ]);
  const [row] = await db
    .select()
    .from(databasesTable)
    .where(eq(databasesTable.id, "db_main"));
  assert.equal(row.serverId, "srv_3");
});

test("an App of the same Environment reaches the database by its name after the move", async () => {
  const cluster = await eu(["srv_2", "srv_3", "srv_4"]);
  await main(cluster.id);
  await backedUp({ startedAt: TODAY_1415 });
  await web(cluster.id, "srv_3");

  await apply(cluster.id, ...failedOver(cluster.id, "srv_4"));

  // The App's member still holds the name; it now leads to the member the database was restored on.
  assert.deepEqual(
    last("srv_3").hold.map((h) => [h.name, h.workloadId, h.port]),
    [["db-main", "db_main", 5432]],
  );
  assert.deepEqual(
    last("srv_4").serve.map((s) => [s.workloadId, s.sourceFingerprints]),
    [["db_main", [fp(3)]]],
  );
  // The server that lost it serves it to nobody.
  assert.deepEqual(last("srv_2").serve, []);
});

test("after a failover onto the server that keeps its backups, the leader is told there is nothing left to restore from", async () => {
  const cluster = await eu();
  await main(cluster.id);
  await seedDestination(db, {
    id: "dst_srv3",
    kind: "server",
    serverId: "srv_3",
  });
  await backedUp({ destinationId: "dst_srv3", startedAt: TODAY_1415 });
  await pushDatabaseBundle("db_main");
  assert.equal((await open()).restore!.storeMember, "srv_3");

  await apply(cluster.id, ...failedOver(cluster.id));

  assert.equal((await open()).restore, undefined);
  assert.deepEqual(await cannot(), [
    "main cannot fail over yet: its backups are kept on server-3, the server it runs on, so they would stop with it. Pick another destination for its backup. Cluster eu will not move it to another server until that is fixed.",
  ]);
});

test("a published database's address follows it to the new server", async () => {
  const cluster = await eu();
  await main(cluster.id);
  await db
    .update(databasesTable)
    .set({ exposedPublicly: true, exposedPort: 15432 })
    .where(eq(databasesTable.id, "db_main"));
  await backedUp({ startedAt: TODAY_1415 });

  await apply(cluster.id, ...failedOver(cluster.id));

  const [row] = await db
    .select()
    .from(databasesTable)
    .where(eq(databasesTable.id, "db_main"));
  assert.equal(
    decryptSecretOrThrow(row.connectionStringEnc, "the connection string"),
    "postgres://app:pw@10.0.0.3:15432/db-main",
  );
});

test("a database that found no room is named as waiting, in its own team", async () => {
  const cluster = await eu();
  await main(cluster.id, TEAM_B);

  await apply(
    cluster.id,
    event(cluster.id, "placement", {
      kind: "database",
      workloadId: "db_main",
      members: [""],
      epoch: 1,
    }),
    event(cluster.id, "failover", {
      member: "srv_2",
      reason: "stopped_answering",
      moved: [],
      waiting: [
        {
          kind: "database",
          workloadId: "db_main",
          reason: "no_room",
          neededMb: 256,
        },
      ],
    }),
  );

  assert.deepEqual(
    (await deploSaid(TEAM_B)).filter((m) => /waiting/.test(m)),
    [
      "main is waiting for room in eu: server-2 stopped answering and no other server has room yet",
    ],
  );
  assert.deepEqual(
    (await deploSaid(TEAM_A)).filter((m) => /waiting/.test(m)),
    [],
  );
  // It still names the server it last ran on: nothing else is known to hold its data.
  const [row] = await db
    .select()
    .from(databasesTable)
    .where(eq(databasesTable.id, "db_main"));
  assert.equal(row.serverId, "srv_2");
});

test("a database's failover is a marker on its charts, read over MCP too and by no other team", async () => {
  const cluster = await eu();
  await main(cluster.id);
  await backedUp({ startedAt: TODAY_1415 });
  const before = Date.now();
  await apply(cluster.id, ...failedOver(cluster.id));

  const markers = await asAdmin(() => getDatabaseMetricsMarkers("db_main"));
  assert.deepEqual(
    markers.map((m) => m.label),
    ["Restored main on server-3 from the backup of 14:15"],
  );
  assert.ok(markers[0].ts >= before && markers[0].ts <= Date.now());

  const got = await runTool(
    { userId: USER_1, teamId: TEAM_A },
    "metrics_history",
    { kind: "database", id: "db_main" },
  );
  assert.equal(got.error, undefined, got.error ?? "");
  assert.deepEqual(
    (
      got.data as { databaseMetricsMarkers: { label: string }[] }
    ).databaseMetricsMarkers.map((m) => m.label),
    ["Restored main on server-3 from the backup of 14:15"],
  );

  assert.deepEqual(
    await runWithIdentity({ userId: "user_b", teamId: TEAM_B }, () =>
      getDatabaseMetricsMarkers("db_main"),
    ),
    [],
  );
});
