import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../../db/test-harness";
import { __setTestDb, __resetTestDb } from "../../db/client";
import { runWithIdentity } from "../../auth/request-context";
import { deployments as deploymentsTable } from "../../db/schema/control-plane/deployments";
import { seedIdentity, TEAM_A, USER_1 } from "../identity-test-helpers";
import { seedServer, seedApp, seedDeployment } from "../app-graph-test-helpers";
import { redeploy } from "./stack-actions";

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
  await pg.query(`truncate table
    activities, deployments, app_previews, apps, servers,
    membership_capabilities, memberships, users, teams
    restart identity cascade;`);
  await seedIdentity(db, {
    teams: [{ id: TEAM_A, slug: "alpha" }],
    users: [{ id: USER_1, teamId: TEAM_A, role: "owner" }],
  });
  await seedServer(db);
  await seedApp(db, { id: "prj_web", slug: "web", source: "github" });
});

const as = <T>(fn: () => Promise<T>) =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);

const countOf = async (appId: string) =>
  (
    await db
      .select({ id: deploymentsTable.id })
      .from(deploymentsTable)
      .where(eq(deploymentsTable.appId, appId))
  ).length;

test("a redeploy from a deployment rebuilds that deployment's branch", async () => {
  await seedDeployment(db, {
    id: "dpl_tag",
    appId: "prj_web",
    branch: "v1.2.0",
    status: "error",
  });
  const again = await as(() => redeploy("prj_web", "dpl_tag"));
  assert.equal(again.branch, "v1.2.0");
  assert.equal(again.environment, "production");
});

test("a redeploy of the app follows the app's branch", async () => {
  await seedDeployment(db, { id: "dpl_old", appId: "prj_web", branch: "dev" });
  assert.equal((await as(() => redeploy("prj_web"))).branch, "main");
});

test("a preview deployment is never redeployed to production", async () => {
  await seedDeployment(db, {
    id: "dpl_pr",
    appId: "prj_web",
    environment: "preview",
    prNumber: 7,
    branch: "feat/login",
    status: "error",
  });
  await assert.rejects(
    () => as(() => redeploy("prj_web", "dpl_pr")),
    /preview/i,
  );
  assert.equal(await countOf("prj_web"), 1);
});

test("a deployment of another app is refused", async () => {
  await seedApp(db, { id: "prj_api", slug: "api", source: "github" });
  await seedDeployment(db, { id: "dpl_api", appId: "prj_api", branch: "dev" });
  await assert.rejects(
    () => as(() => redeploy("prj_web", "dpl_api")),
    /not found/i,
  );
  assert.equal(await countOf("prj_web"), 0);
});
