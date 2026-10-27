import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { PGlite } from "@electric-sql/pglite";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { runWithIdentity } from "../auth/request-context";
import {
  seedIdentity,
  TRUNCATE_IDENTITY,
  TEAM_A,
} from "./identity-test-helpers";
import {
  seedServer,
  seedApp,
  seedDeployment,
  seedPreview,
  TRUNCATE_PROJECT_GRAPH,
} from "./app-graph-test-helpers";
import { getDeployment } from "./deployments/deployment-queries";

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
const APP = "prj_web";
const at = (n: number) => `2026-01-01T00:00:0${n}.000Z`;

const get = (id: string) =>
  runWithIdentity({ userId: OWNER, teamId: TEAM_A }, async () => {
    const dep = await getDeployment(id);
    assert.ok(dep);
    return dep;
  });

beforeEach(async () => {
  await pg.exec(TRUNCATE_PROJECT_GRAPH);
  await pg.exec(TRUNCATE_IDENTITY);
  await seedIdentity(db, {
    teams: [{ id: TEAM_A, slug: "alpha" }],
    users: [{ id: OWNER, teamId: TEAM_A, role: "owner" }],
  });
  await seedServer(db, "srv_run");
  await seedServer(db, "srv_build");
  await seedApp(db, { id: APP, teamId: TEAM_A, serverId: "srv_run" });
});

test("only the newest ready build is live", async () => {
  await seedDeployment(db, { id: "d1", appId: APP, createdAt: at(1) });
  await seedDeployment(db, { id: "d2", appId: APP, createdAt: at(2) });
  await seedDeployment(db, {
    id: "d3",
    appId: APP,
    createdAt: at(3),
    status: "error",
  });

  assert.equal((await get("d1")).live, false);
  assert.equal((await get("d2")).live, true, "a failed build keeps it live");
  assert.equal((await get("d3")).live, false);
});

test("a preview's builds never take production's place", async () => {
  await seedPreview(db, { id: "pv1", appId: APP, prNumber: 7 });
  await seedDeployment(db, { id: "prod", appId: APP, createdAt: at(1) });
  await seedDeployment(db, {
    id: "pr",
    appId: APP,
    createdAt: at(2),
    environment: "preview",
    previewId: "pv1",
  });

  assert.equal((await get("prod")).live, true);
  assert.equal((await get("pr")).live, true);
});

test("names the server it runs on, and the build server only when apart", async () => {
  await seedDeployment(db, {
    id: "here",
    appId: APP,
    serverId: "srv_run",
    buildServerId: "srv_run",
  });
  await seedDeployment(db, {
    id: "apart",
    appId: APP,
    serverId: "srv_run",
    buildServerId: "srv_build",
  });

  const here = await get("here");
  assert.equal(here.serverName, "srv_run");
  assert.equal(here.buildServerName, null);
  assert.equal((await get("apart")).buildServerName, "srv_build");
});
