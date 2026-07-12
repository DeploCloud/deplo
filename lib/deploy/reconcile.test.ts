import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PGlite } from "@electric-sql/pglite";
import { asc, eq } from "drizzle-orm";

// DEPLO_DATA_DIR points build staging at a throwaway dir, set BEFORE the store +
// build modules load. The relational backend is pglite (the in-memory store mode
// is gone for the project graph — cut-set (c) reads/writes Postgres).
process.env.DEPLO_DATA_DIR = mkdtempSync(join(tmpdir(), "deplo-reconcile-"));

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import {
  deployments as deploymentsTable,
  deploymentLogs,
  apps as appsTable,
} from "../db/schema/control-plane";
import { seedIdentity, TEAM_A, USER_1 } from "../data/identity-test-helpers";
import {
  seedServer,
  seedApp,
  seedDeployment,
  TRUNCATE_PROJECT_GRAPH,
} from "../data/app-graph-test-helpers";
import { isInFlightStatus, reconcileInFlightDeployments } from "./build";
import { __resetDeploymentLogBuffers } from "../data/deployment-logs";

/**
 * Step 4 deployment-reconcile test (relational-store PLAN §8 "Rewrite the
 * store-coupled tests inside the cut-sets"). The reconcile marks orphaned
 * `building` deployments + their apps `error` at boot. `queued` deployments
 * are DURABLE (no build started, nothing lost): reconcile leaves them queued for
 * the per-server deploy queue to re-drain at boot. Seeded via the Drizzle
 * test-seed helpers against pglite.
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

beforeEach(async () => {
  __resetDeploymentLogBuffers();
  await pg.exec(`${TRUNCATE_PROJECT_GRAPH}
    truncate table users, teams restart identity cascade;`);
  await seedIdentity(db, { users: [{ id: USER_1, teamId: TEAM_A, role: "owner" }] });
  await seedServer(db);
});

test("isInFlightStatus identifies non-terminal deploy states", () => {
  assert.equal(isInFlightStatus("queued"), true);
  assert.equal(isInFlightStatus("building"), true);
  assert.equal(isInFlightStatus("ready"), false);
  assert.equal(isInFlightStatus("error"), false);
  assert.equal(isInFlightStatus("canceled"), false);
});

test("reconcile errors orphaned building deploys but leaves queued durable", async () => {
  // prj_1 is mid-BUILD (its latest deploy dpl_a was building); prj_2 only has a
  // QUEUED deploy dpl_b (never started) — that one must survive the restart.
  await seedApp(db, { id: "prj_1", status: "building" });
  await seedApp(db, { id: "prj_2", status: "queued" });
  await seedDeployment(db, { id: "dpl_a", appId: "prj_1", status: "building" });
  await seedDeployment(db, { id: "dpl_b", appId: "prj_2", status: "queued" });
  await seedDeployment(db, { id: "dpl_c", appId: "prj_1", status: "ready" });

  const n = await reconcileInFlightDeployments();
  assert.equal(n, 1, "only the one BUILDING deploy is reconciled to error");

  const deps = await db.select().from(deploymentsTable).orderBy(asc(deploymentsTable.id));
  const byId = new Map(deps.map((d) => [d.id, d]));
  assert.equal(byId.get("dpl_a")!.status, "error", "orphaned building -> error");
  assert.equal(byId.get("dpl_b")!.status, "queued", "queued is durable — left for re-drain");
  assert.equal(byId.get("dpl_c")!.status, "ready", "ready is untouched");

  const proj1 = await db.select().from(appsTable).where(eq(appsTable.id, "prj_1"));
  assert.equal(proj1[0]!.status, "error", "the mid-build project settles off building");
  const proj2 = await db.select().from(appsTable).where(eq(appsTable.id, "prj_2"));
  assert.equal(proj2[0]!.status, "queued", "the queued project stays queued for re-drain");

  // Only the errored (building) deployment got an interrupted-log line.
  const logsA = await db
    .select()
    .from(deploymentLogs)
    .where(eq(deploymentLogs.deploymentId, "dpl_a"));
  assert.equal(logsA.length, 1);
  assert.match(logsA[0]!.text, /interrupted by a control-plane restart/);
  const logsB = await db
    .select()
    .from(deploymentLogs)
    .where(eq(deploymentLogs.deploymentId, "dpl_b"));
  assert.equal(logsB.length, 0, "the durable queued deploy is not logged as interrupted");
});

test("reconcile is idempotent — a second run finds nothing", async () => {
  await seedApp(db, { id: "prj_1", status: "active" });
  await seedDeployment(db, { id: "dpl_x", appId: "prj_1", status: "ready" });
  assert.equal(await reconcileInFlightDeployments(), 0);
});
