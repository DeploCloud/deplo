import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import {
  apps as appsTable,
  databases as databasesTable,
} from "../db/schema/control-plane";
import { runWithIdentity } from "../auth/request-context";
import {
  seedIdentity,
  TEAM_A,
  TEAM_B,
  USER_1,
} from "./identity-test-helpers";
import { seedServer, seedApp, SERVER_1 } from "./app-graph-test-helpers";
import { seedDatabase } from "./backup-test-helpers";
import {
  setAppSaveMetrics,
  setDatabaseSaveMetrics,
  getAppMetricsHistory,
  getDatabaseMetricsHistory,
  listSaveMetricsTargetsForCollector,
  type ContainerMetricsSample,
} from "./container-metrics";
import {
  recordContainerSample,
  getContainerHistory,
  clearContainerHistory,
  markContainerWatched,
  clearContainerWatches,
} from "../monitoring/container-history";

/**
 * Data-layer tests for the per-app / per-database "Save metrics" switch: default
 * OFF, `manage_infra`-gated, team-scoped (a cross-team id hits 0 rows), the OFF
 * flip drops the buffered history, and the session-free collector enumeration.
 * The live measurement path (getAppMetrics) dials the agent and is covered e2e.
 */

let db: TestDb;
let pg: PGlite;

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
});

after(async () => {
  __resetTestDb();
  await pg.close();
});

const USER_VIEWER = "user_viewer";
const USER_B = "user_b";

const asOwner = <T>(fn: () => Promise<T>) =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);
const asViewer = <T>(fn: () => Promise<T>) =>
  runWithIdentity({ userId: USER_VIEWER, teamId: TEAM_A }, fn);
const asOtherTeam = <T>(fn: () => Promise<T>) =>
  runWithIdentity({ userId: USER_B, teamId: TEAM_B }, fn);

// Read-time eviction is relative to Date.now(), so use a near-now timestamp.
const NOW = Date.now();

function sample(id: string, ts: number): ContainerMetricsSample {
  return {
    id,
    online: true,
    ts,
    cpu: 1,
    memUsed: 1,
    memLimit: 10,
    memPct: 10,
    netRx: 0,
    netTx: 0,
    blockRead: 0,
    blockWrite: 0,
    pids: 1,
    running: 1,
    containers: 1,
  };
}

beforeEach(async () => {
  clearContainerHistory();
  clearContainerWatches();
  await pg.exec(
    `truncate table apps, databases, servers, activities, users, teams restart identity cascade;`,
  );
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      { id: USER_VIEWER, teamId: TEAM_A, role: "viewer", capabilities: ["view"] },
      { id: USER_B, teamId: TEAM_B, role: "owner" },
    ],
  });
  await seedServer(db);
  await seedApp(db, { id: "prj_1", slug: "app-one" });
  await seedDatabase(db, { id: "db_1" });
});

test("apps and databases are born with save_metrics OFF", async () => {
  const [a] = await db
    .select({ saveMetrics: appsTable.saveMetrics })
    .from(appsTable)
    .where(eq(appsTable.id, "prj_1"));
  const [d] = await db
    .select({ saveMetrics: databasesTable.saveMetrics })
    .from(databasesTable)
    .where(eq(databasesTable.id, "db_1"));
  assert.equal(a.saveMetrics, false);
  assert.equal(d.saveMetrics, false);
});

test("setAppSaveMetrics toggles the flag and persists", async () => {
  const res = await asOwner(() => setAppSaveMetrics("prj_1", true));
  assert.deepEqual(res, { saveMetrics: true });
  const [row] = await db
    .select({ saveMetrics: appsTable.saveMetrics })
    .from(appsTable)
    .where(eq(appsTable.id, "prj_1"));
  assert.equal(row.saveMetrics, true);

  await asOwner(() => setAppSaveMetrics("prj_1", false));
  const [row2] = await db
    .select({ saveMetrics: appsTable.saveMetrics })
    .from(appsTable)
    .where(eq(appsTable.id, "prj_1"));
  assert.equal(row2.saveMetrics, false);
});

test("turning an app's switch OFF drops its buffered history", async () => {
  await asOwner(() => setAppSaveMetrics("prj_1", true));
  recordContainerSample(sample("prj_1", NOW));
  assert.equal(getContainerHistory("prj_1").length, 1);
  await asOwner(() => setAppSaveMetrics("prj_1", false));
  assert.equal(getContainerHistory("prj_1").length, 0);
});

test("setDatabaseSaveMetrics toggles + OFF drops the buffer", async () => {
  const res = await asOwner(() => setDatabaseSaveMetrics("db_1", true));
  assert.deepEqual(res, { saveMetrics: true });
  recordContainerSample(sample("db_1", NOW));
  await asOwner(() => setDatabaseSaveMetrics("db_1", false));
  assert.equal(getContainerHistory("db_1").length, 0);
});

test("the toggles require manage_infra", async () => {
  await assert.rejects(() => asViewer(() => setAppSaveMetrics("prj_1", true)), /permission|capab/i);
  await assert.rejects(
    () => asViewer(() => setDatabaseSaveMetrics("db_1", true)),
    /permission|capab/i,
  );
});

test("a cross-team id can't be toggled (hits 0 rows / not found)", async () => {
  await assert.rejects(() => asOtherTeam(() => setAppSaveMetrics("prj_1", true)));
  await assert.rejects(() => asOtherTeam(() => setDatabaseSaveMetrics("db_1", true)));
  // The real rows stayed OFF.
  const [a] = await db
    .select({ saveMetrics: appsTable.saveMetrics })
    .from(appsTable)
    .where(eq(appsTable.id, "prj_1"));
  assert.equal(a.saveMetrics, false);
});

test("metrics history reads are team-scoped", async () => {
  recordContainerSample(sample("prj_1", NOW));
  recordContainerSample(sample("db_1", NOW));
  // Same team sees the buffered window…
  assert.equal((await asOwner(() => getAppMetricsHistory("prj_1"))).length, 1);
  assert.equal((await asOwner(() => getDatabaseMetricsHistory("db_1"))).length, 1);
  // …another team gets nothing (the row isn't theirs).
  assert.equal((await asOtherTeam(() => getAppMetricsHistory("prj_1"))).length, 0);
  assert.equal((await asOtherTeam(() => getDatabaseMetricsHistory("db_1"))).length, 0);
});

test("listSaveMetricsTargetsForCollector returns only opted-in apps + databases", async () => {
  // Nothing opted in yet.
  assert.equal((await listSaveMetricsTargetsForCollector()).length, 0);

  await asOwner(() => setAppSaveMetrics("prj_1", true));
  await asOwner(() => setDatabaseSaveMetrics("db_1", true));

  const targets = await listSaveMetricsTargetsForCollector();
  const ids = targets.map((t) => t.id).sort();
  assert.deepEqual(ids, ["db_1", "prj_1"]);
  // Each carries the owning server so the collector can dial it.
  for (const t of targets) assert.equal(t.serverId, SERVER_1);
});

test("a recently-WATCHED resource is a collector target even with the switch off", async () => {
  // The default is OFF, so without this the collector ignored ~every app and a
  // reopened Monitoring tab could only chart the seconds since it mounted.
  assert.equal((await listSaveMetricsTargetsForCollector()).length, 0);

  markContainerWatched("prj_1", SERVER_1);

  const targets = await listSaveMetricsTargetsForCollector();
  assert.deepEqual(targets, [{ id: "prj_1", serverId: SERVER_1 }]);
});

test("a resource both opted in and watched is enumerated once", async () => {
  await asOwner(() => setAppSaveMetrics("prj_1", true));
  markContainerWatched("prj_1", SERVER_1);

  const targets = await listSaveMetricsTargetsForCollector();
  assert.deepEqual(
    targets.filter((t) => t.id === "prj_1").length,
    1,
    "the union must de-dupe or the collector double-samples the same stack",
  );
});
