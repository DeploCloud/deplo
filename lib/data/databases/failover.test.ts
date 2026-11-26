import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../../db/test-harness";
import { __setTestDb, __resetTestDb } from "../../db/client";
import {
  backupDestination as destTable,
  backups as backupsTable,
} from "../../db/schema/control-plane/backups";
import {
  clusterMembers,
  clusters,
} from "../../db/schema/control-plane/clusters";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import { servers as serversTable } from "../../db/schema/control-plane/servers";
import { activities as activitiesTable } from "../../db/schema/control-plane/activity";
import {
  clearMetricsHistory,
  recordMetricsSample,
} from "../../monitoring/history";
import type { ServerMetrics } from "../../types/server";
import { seedIdentity, TEAM_A } from "../identity-test-helpers";
import { seedServerRow } from "../infra-test-helpers";
import { seedApp } from "../app-graph-test-helpers";
import { seedRun } from "../backup-test-helpers";
import { ensureFailoverBackup, rehomeFailoverBackups } from "./failover";

let db: TestDb;
let pg: PGlite;
const GB = 1e9;
const MEMBERS = ["srv_1", "srv_2", "srv_3"];

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
});
after(async () => {
  __resetTestDb();
  await pg.close();
});
beforeEach(async () => {
  for (const t of [backupsTable, destTable, activitiesTable, clusterMembers])
    await db.delete(t);
  await db.delete(clusters);
  clearMetricsHistory();
  await seedIdentity(db);
  for (const [i, id] of MEMBERS.entries()) {
    await seedServerRow(db, { id, name: `eu-${i + 1}` });
    await db
      .update(serversTable)
      .set({ agentCertFingerprint: String(i + 1).repeat(64) })
      .where(eq(serversTable.id, id));
  }
  await db
    .insert(clusters)
    .values({ id: "cl_eu", name: "eu", createdAt: "2026-11-01T00:00:00.000Z" });
  for (const [i, serverId] of MEMBERS.entries())
    await db.insert(clusterMembers).values({
      serverId,
      clusterId: "cl_eu",
      joinedAt: `2026-11-0${i + 1}T00:00:00.000Z`,
    });
});

function disk(serverId: string, freeGb: number, totalGb = 14) {
  clearMetricsHistory(serverId);
  recordMetricsSample({
    serverId,
    online: true,
    diskUsed: (totalGb - freeGb) * GB,
    diskTotal: totalGb * GB,
    diskPct: 0,
    ts: Date.now(),
  } as ServerMetrics);
}

async function app(id: string, serverId: string) {
  await seedApp(db, { id, serverId, slug: id });
  await db
    .update(appsTable)
    .set({ clusterId: "cl_eu" })
    .where(eq(appsTable.id, id));
  await ensureFailoverBackup(
    { id, teamId: TEAM_A, name: id, serverId, clusterId: "cl_eu" },
    "app",
  );
}

async function keptOn(appId: string): Promise<string> {
  const [row] = await db
    .select({ serverId: destTable.serverId })
    .from(backupsTable)
    .innerJoin(destTable, eq(destTable.id, backupsTable.destinationId))
    .where(eq(backupsTable.appId, appId));
  return row!.serverId!;
}

// c44: every kit App's backups went to the team's first destination, eu-1, until it was 90% full.
test("Deplo's own backups go to the other member with the most free disk", async () => {
  disk("srv_1", 2);
  disk("srv_2", 3);
  disk("srv_3", 6);
  await app("prj_a", "srv_1");
  await app("prj_c", "srv_3");
  assert.equal(await keptOn("prj_a"), "srv_3");
  assert.equal(await keptOn("prj_c"), "srv_2");
});

test("what Deplo's backups already headed to a member will still write counts against its room", async () => {
  disk("srv_1", 2);
  disk("srv_2", 4);
  disk("srv_3", 5);
  await app("prj_a", "srv_1");
  assert.equal(await keptOn("prj_a"), "srv_3");
  // prj_a keeps 8 runs of 0.5 GB on srv_3: 3.5 GB more, so srv_3 has 1.5 GB left for anyone else.
  await seedRun(db, {
    id: "brun_a1",
    targetKind: "app",
    appId: "prj_a",
    destinationId: (await db.select().from(destTable))[0]!.id,
    sizeBytes: 0.5 * GB,
  });
  await app("prj_b", "srv_1");
  assert.equal(await keptOn("prj_b"), "srv_2");
});

test("a member past 80% used hands Deplo's backups to the one with the most room, and says so", async () => {
  disk("srv_1", 6);
  disk("srv_2", 4);
  disk("srv_3", 3);
  await app("prj_c", "srv_3");
  assert.equal(await keptOn("prj_c"), "srv_1");

  disk("srv_1", 1.4);
  await rehomeFailoverBackups("cl_eu");
  assert.equal(await keptOn("prj_c"), "srv_2");
  const said = await db.select().from(activitiesTable);
  assert.ok(
    said.some(
      (a) =>
        a.message ===
        "Backs up prj_c every 15 minutes to eu-2 from now on: eu-1 is more than 80% full.",
    ),
    said.map((a) => a.message).join(" | "),
  );

  // Every other member is as full: the backups stay where they are.
  disk("srv_2", 1);
  await rehomeFailoverBackups("cl_eu");
  assert.equal(await keptOn("prj_c"), "srv_2");
});
