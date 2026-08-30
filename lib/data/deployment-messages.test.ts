import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { PGlite } from "@electric-sql/pglite";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { runWithIdentity } from "../auth/request-context";
import { seedIdentity, TEAM_A, USER_1 } from "./identity-test-helpers";
import { seedServer, seedApp } from "./app-graph-test-helpers";
import { redeploy } from "./deployments";
import { rebuildApp } from "./apps";
import { deployments as deploymentsTable } from "../db/schema/control-plane";
import { eq } from "drizzle-orm";

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
    activities, deployments, apps, servers,
    membership_capabilities, memberships, users, teams
    restart identity cascade;`);
  await seedIdentity(db, {
    teams: [{ id: TEAM_A, slug: "alpha" }],
    users: [{ id: USER_1, teamId: TEAM_A, role: "owner" }],
  });
  await seedServer(db);
});

const messageOf = (appId: string) =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, () =>
    redeploy(appId),
  ).then((d) => d.commitMessage);

test("a repo redeploy still names the commit", async () => {
  await seedApp(db, { id: "prj_git", source: "github" });
  assert.equal(await messageOf("prj_git"), "Redeploy of latest commit");
});

test("a compose stack has no commit to redeploy", async () => {
  await seedApp(db, {
    id: "prj_yaml",
    source: "compose",
    compose: "services:",
  });
  const msg = await messageOf("prj_yaml");
  assert.equal(msg, "Redeploy of the compose stack");
  assert.ok(!msg.includes("commit"));
});

test("an image redeploy names the image", async () => {
  await seedApp(db, { id: "prj_img", source: "docker-image" });
  assert.equal(await messageOf("prj_img"), "Redeploy of latest image");
});

const rebuildMessageOf = async (appId: string) => {
  await runWithIdentity({ userId: USER_1, teamId: TEAM_A }, () =>
    rebuildApp(appId),
  );
  const [row] = await db
    .select({ message: deploymentsTable.commitMessage })
    .from(deploymentsTable)
    .where(eq(deploymentsTable.appId, appId))
    .limit(1);
  return row!.message;
};

test("a rebuild names what it actually recreates", async () => {
  await seedApp(db, { id: "prj_r", source: "github" });
  await seedApp(db, { id: "prj_c", source: "compose", compose: "services:" });
  await seedApp(db, { id: "prj_i", source: "docker-image" });
  assert.equal(await rebuildMessageOf("prj_r"), "Rebuild container");
  assert.equal(
    await rebuildMessageOf("prj_c"),
    "Recreate the stack's containers",
  );
  assert.equal(
    await rebuildMessageOf("prj_i"),
    "Pull and recreate the container",
  );
});
