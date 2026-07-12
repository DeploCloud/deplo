import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import {
  deployments as deploymentsTable,
  deploymentLogs,
  apps as appsTable,
} from "../db/schema/control-plane";
import { runWithIdentity } from "../auth/request-context";
import {
  seedIdentity,
  TRUNCATE_IDENTITY,
  TEAM_A,
  TEAM_B,
} from "./identity-test-helpers";
import {
  seedServer,
  seedApp,
  seedDeployment,
  TRUNCATE_PROJECT_GRAPH,
} from "./app-graph-test-helpers";
import { deleteDeployments, deleteAllDeployments } from "./deployments";

/**
 * `deleteDeployments` / `deleteAllDeployments` against pglite. The contract behind
 * the deployments table's multi-select delete: only FINISHED deployments are
 * removed (an in-progress one must be canceled first), the delete is team-scoped,
 * and the FKs do the cleanup — logs cascade, a `latest_deployment_id` pointer NULLs.
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

const OWNER = "u_owner";
const OWNER_B = "u_owner_b";
const SVC = "prj_svc";

const as = <T>(userId: string, teamId: string, fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId, teamId }, fn);

beforeEach(async () => {
  await pg.exec(TRUNCATE_PROJECT_GRAPH);
  await pg.exec(TRUNCATE_IDENTITY);
  await seedIdentity(db, {
    teams: [
      { id: TEAM_A, slug: "alpha" },
      { id: TEAM_B, slug: "beta" },
    ],
    users: [
      { id: OWNER, teamId: TEAM_A, role: "owner" },
      { id: OWNER_B, teamId: TEAM_B, role: "owner" },
    ],
  });
  await seedServer(db);
  await seedApp(db, { id: SVC, teamId: TEAM_A });
  await seedDeployment(db, { id: "dep_ready", appId: SVC, status: "ready" });
  await seedDeployment(db, { id: "dep_error", appId: SVC, status: "error" });
  await seedDeployment(db, { id: "dep_canceled", appId: SVC, status: "canceled" });
  await seedDeployment(db, { id: "dep_queued", appId: SVC, status: "queued" });
  await seedDeployment(db, { id: "dep_building", appId: SVC, status: "building" });
});

const remaining = async (): Promise<string[]> =>
  (await db.select({ id: deploymentsTable.id }).from(deploymentsTable))
    .map((r) => r.id)
    .sort();

test("deleteDeployments removes finished ones and leaves in-progress builds", async () => {
  const n = await as(OWNER, TEAM_A, () =>
    deleteDeployments([
      "dep_ready",
      "dep_error",
      "dep_canceled",
      "dep_queued",
      "dep_building",
    ]),
  );
  assert.equal(n, 3, "only the three finished deployments delete");
  assert.deepEqual(
    await remaining(),
    ["dep_building", "dep_queued"],
    "queued/building survive — they must be canceled first",
  );
});

test("deleteAllDeployments(appId) clears finished, keeps in-progress", async () => {
  const n = await as(OWNER, TEAM_A, () => deleteAllDeployments(SVC));
  assert.equal(n, 3);
  assert.deepEqual(await remaining(), ["dep_building", "dep_queued"]);
});

test("deleteAllDeployments() sweeps the whole team's finished deployments", async () => {
  const n = await as(OWNER, TEAM_A, () => deleteAllDeployments());
  assert.equal(n, 3, "every finished deployment the caller may manage is removed");
  assert.deepEqual(await remaining(), ["dep_building", "dep_queued"]);
});

test("deleting a deployment cascades its build logs", async () => {
  await db.insert(deploymentLogs).values({
    deploymentId: "dep_ready",
    ts: "2026-01-01T00:00:00.000Z",
    level: "info",
    text: "building…",
  });
  await as(OWNER, TEAM_A, () => deleteDeployments(["dep_ready"]));
  const logs = await db
    .select({ id: deploymentLogs.id })
    .from(deploymentLogs)
    .where(eq(deploymentLogs.deploymentId, "dep_ready"));
  assert.equal(logs.length, 0, "logs are gone via the ON DELETE CASCADE FK");
});

test("deleting the service's latest deployment NULLs the pointer (set-null FK)", async () => {
  await db
    .update(appsTable)
    .set({ latestDeploymentId: "dep_ready" })
    .where(eq(appsTable.id, SVC));
  await as(OWNER, TEAM_A, () => deleteDeployments(["dep_ready"]));
  const svc = (
    await db
      .select({ latest: appsTable.latestDeploymentId })
      .from(appsTable)
      .where(eq(appsTable.id, SVC))
  )[0]!;
  assert.equal(svc.latest, null, "the stale pointer is cleared, not orphaned");
});

test("a caller can't delete another team's deployments (team isolation)", async () => {
  const n = await as(OWNER_B, TEAM_B, () =>
    deleteDeployments(["dep_ready", "dep_error"]),
  );
  assert.equal(n, 0, "foreign ids aren't found for team B");
  assert.equal(
    (await remaining()).length,
    5,
    "team A's deployments are untouched",
  );
});
