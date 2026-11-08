import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../../db/test-harness";
import { __setTestDb, __resetTestDb } from "../../db/client";
import { apps } from "../../db/schema/control-plane/apps";
import { runWithIdentity } from "../../auth/request-context";
import { seedIdentity, TEAM_A, TEAM_B } from "../identity-test-helpers";
import {
  TRUNCATE_PROJECT_GRAPH,
  seedApp,
  seedServer,
} from "../app-graph-test-helpers";
import { setAppZeroDowntimeDeploys } from "./settings";

let db: TestDb;
let pg: PGlite;
const OWNER = "u_owner";
const VIEWER = "u_viewer";
const STRANGER = "u_stranger";
const APP = "prj_web";

const as = <T>(userId: string, teamId: string, fn: () => Promise<T>) =>
  runWithIdentity({ userId, teamId }, fn);

const enabled = async () =>
  (await db.select().from(apps).where(eq(apps.id, APP)))[0].zeroDowntimeDeploys;

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
});

after(async () => {
  __resetTestDb();
  await pg.close();
});

beforeEach(async () => {
  await pg.exec(TRUNCATE_PROJECT_GRAPH);
  await pg.exec(
    `truncate table membership_capabilities, memberships, users, teams restart identity cascade;`,
  );
  await seedIdentity(db, {
    users: [
      { id: OWNER, teamId: TEAM_A, role: "owner" },
      { id: VIEWER, teamId: TEAM_A, role: "member", capabilities: ["view"] },
      { id: STRANGER, teamId: TEAM_B, role: "owner" },
    ],
  });
  await seedServer(db);
  await seedApp(db, { id: APP, teamId: TEAM_A, slug: "web" });
});

test("zero-downtime deploys are off until someone turns them on", async () => {
  assert.equal(await enabled(), false);
  await as(OWNER, TEAM_A, () => setAppZeroDowntimeDeploys(APP, true));
  assert.equal(await enabled(), true);
  await as(OWNER, TEAM_A, () => setAppZeroDowntimeDeploys(APP, false));
  assert.equal(await enabled(), false);
});

test("only a member who may configure the app turns them on", async () => {
  await assert.rejects(
    as(VIEWER, TEAM_A, () => setAppZeroDowntimeDeploys(APP, true)),
    /permission/,
  );
  assert.equal(await enabled(), false);
});

test("another team's app is out of reach", async () => {
  await assert.rejects(
    as(STRANGER, TEAM_B, () => setAppZeroDowntimeDeploys(APP, true)),
  );
  assert.equal(await enabled(), false);
});
