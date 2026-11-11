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
import { setAppRestartWhenUnresponsive } from "./settings";

let db: TestDb;
let pg: PGlite;
const OWNER = "u_owner";
const VIEWER = "u_viewer";
const STRANGER = "u_stranger";
const APP = "prj_web";

const as = <T>(userId: string, teamId: string, fn: () => Promise<T>) =>
  runWithIdentity({ userId, teamId }, fn);

const row = async () =>
  (await db.select().from(apps).where(eq(apps.id, APP)))[0];

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

test("automatic restart is on until someone turns it off", async () => {
  assert.equal((await row()).restartWhenUnresponsive, true);
  await as(OWNER, TEAM_A, () => setAppRestartWhenUnresponsive(APP, false));
  assert.equal((await row()).restartWhenUnresponsive, false);
  await as(OWNER, TEAM_A, () => setAppRestartWhenUnresponsive(APP, true));
  assert.equal((await row()).restartWhenUnresponsive, true);
});

test("changing the switch marks the app as needing a deploy; the pause stays until that deploy, as on its server", async () => {
  await db
    .update(apps)
    .set({ restartsPausedAt: "2026-11-10T03:00:00.000Z" })
    .where(eq(apps.id, APP));
  await as(OWNER, TEAM_A, () => setAppRestartWhenUnresponsive(APP, false));
  const after = await row();
  assert.equal(after.restartsPausedAt, "2026-11-10T03:00:00.000Z");
  assert.ok(after.pendingChangesAt);
});

test("only a member who may configure the app changes it", async () => {
  await assert.rejects(
    as(VIEWER, TEAM_A, () => setAppRestartWhenUnresponsive(APP, false)),
    /permission/,
  );
  assert.equal((await row()).restartWhenUnresponsive, true);
});

test("another team's app is out of reach", async () => {
  await assert.rejects(
    as(STRANGER, TEAM_B, () => setAppRestartWhenUnresponsive(APP, false)),
  );
  assert.equal((await row()).restartWhenUnresponsive, true);
});
