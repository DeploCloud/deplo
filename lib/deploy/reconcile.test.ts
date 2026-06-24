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
  projects as projectsTable,
} from "../db/schema/control-plane";
import { seedIdentity, TEAM_A, USER_1 } from "../data/identity-test-helpers";
import {
  seedServer,
  seedProject,
  seedDeployment,
  TRUNCATE_PROJECT_GRAPH,
} from "../data/project-graph-test-helpers";
import { isInFlightStatus, reconcileInFlightDeployments } from "./build";
import { __resetDeploymentLogBuffers } from "../data/deployment-logs";

/**
 * Step 4 deployment-reconcile test (relational-store PLAN §8 "Rewrite the
 * store-coupled tests inside the cut-sets"). The reconcile is now async and
 * relational: it marks orphaned `queued`/`building` deployments + their projects
 * `error` at boot. Seeded via the Drizzle test-seed helpers against pglite.
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

test("reconcile marks queued/building deploys (and their projects) errored", async () => {
  await seedProject(db, { id: "prj_1", status: "building" });
  await seedDeployment(db, { id: "dpl_a", projectId: "prj_1", status: "building" });
  await seedDeployment(db, { id: "dpl_b", projectId: "prj_1", status: "queued" });
  await seedDeployment(db, { id: "dpl_c", projectId: "prj_1", status: "ready" });

  const n = await reconcileInFlightDeployments();
  assert.equal(n, 2, "exactly the two in-flight deploys are reconciled");

  const deps = await db.select().from(deploymentsTable).orderBy(asc(deploymentsTable.id));
  const byId = new Map(deps.map((d) => [d.id, d]));
  assert.equal(byId.get("dpl_a")!.status, "error");
  assert.equal(byId.get("dpl_b")!.status, "error");
  assert.equal(byId.get("dpl_c")!.status, "ready", "ready is untouched");

  const proj = await db.select().from(projectsTable).where(eq(projectsTable.id, "prj_1"));
  assert.equal(proj[0]!.status, "error", "the mid-deploy project settles off building");

  // Each reconciled deployment got an interrupted-log line (flushed by reconcile).
  const logsA = await db
    .select()
    .from(deploymentLogs)
    .where(eq(deploymentLogs.deploymentId, "dpl_a"));
  assert.equal(logsA.length, 1);
  assert.match(logsA[0]!.text, /interrupted by a control-plane restart/);
});

test("reconcile is idempotent — a second run finds nothing", async () => {
  await seedProject(db, { id: "prj_1", status: "active" });
  await seedDeployment(db, { id: "dpl_x", projectId: "prj_1", status: "ready" });
  assert.equal(await reconcileInFlightDeployments(), 0);
});
