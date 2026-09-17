import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { apps as appsTable } from "../db/schema/control-plane/apps";
import { databases as databasesTable } from "../db/schema/control-plane/databases";
import { seedIdentity, TEAM_A } from "./identity-test-helpers";
import {
  seedApp,
  seedDeployment,
  seedServer,
  SERVER_1,
  TRUNCATE_PROJECT_GRAPH,
} from "./app-graph-test-helpers";
import { seedDatabase, TRUNCATE_BACKUPS } from "./backup-test-helpers";
import { guardedApps, guardedDatabases } from "./restart-loop-guard";

let db: TestDb;
let pg: PGlite;
const OTHER_SERVER = "srv_2";

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
});

after(() => {
  __resetTestDb();
  void pg.close();
});

beforeEach(async () => {
  await pg.exec(`${TRUNCATE_BACKUPS}
    ${TRUNCATE_PROJECT_GRAPH}
    truncate table activities, servers, users, teams restart identity cascade;`);
  await seedIdentity(db);
  await seedServer(db);
  await seedServer(db, OTHER_SERVER);
});

const ids = async (rows: Promise<{ id: string }[]>) =>
  (await rows).map((r) => r.id).sort();

test("an app whose container loops is picked up", async () => {
  await seedApp(db, { id: "prj_1" });
  assert.deepEqual(await ids(guardedApps(SERVER_1, ["prj_1"])), ["prj_1"]);
});

test("an app with the guard turned off is left alone", async () => {
  await seedApp(db, { id: "prj_1" });
  await db
    .update(appsTable)
    .set({ restartLoopGuard: false })
    .where(eq(appsTable.id, "prj_1"));
  assert.deepEqual(await ids(guardedApps(SERVER_1, ["prj_1"])), []);
});

test("an app with a deploy in flight is left alone", async () => {
  await seedApp(db, { id: "prj_1" });
  await seedDeployment(db, {
    id: "dep_1",
    appId: "prj_1",
    status: "building",
  });
  assert.deepEqual(
    await ids(guardedApps(SERVER_1, ["prj_1"])),
    [],
    "a build restarts its own container; stopping it mid-deploy is not a loop",
  );
});

test("an app being migrated or deleted is left alone", async () => {
  await seedApp(db, { id: "prj_1" });
  await seedApp(db, { id: "prj_2" });
  await db
    .update(appsTable)
    .set({ migrateFromServerId: OTHER_SERVER })
    .where(eq(appsTable.id, "prj_1"));
  await db
    .update(appsTable)
    .set({ deletingAt: "2026-01-01T00:00:00.000Z" })
    .where(eq(appsTable.id, "prj_2"));
  assert.deepEqual(await ids(guardedApps(SERVER_1, ["prj_1", "prj_2"])), []);
});

test("an app that is not active is left alone", async () => {
  await seedApp(db, { id: "prj_1" });
  await db
    .update(appsTable)
    .set({ status: "idle" })
    .where(eq(appsTable.id, "prj_1"));
  assert.deepEqual(await ids(guardedApps(SERVER_1, ["prj_1"])), []);
});

test("an app on another server is never stopped by this one's telemetry", async () => {
  await seedApp(db, { id: "prj_1", serverId: OTHER_SERVER });
  assert.deepEqual(await ids(guardedApps(SERVER_1, ["prj_1"])), []);
});

test("a running database is picked up, a stopped one is not", async () => {
  await seedDatabase(db, { id: "db_1", teamId: TEAM_A, serverId: SERVER_1 });
  await seedDatabase(db, { id: "db_2", teamId: TEAM_A, serverId: SERVER_1 });
  await db
    .update(databasesTable)
    .set({ status: "stopped" })
    .where(eq(databasesTable.id, "db_2"));
  assert.deepEqual(await ids(guardedDatabases(SERVER_1, ["db_1", "db_2"])), [
    "db_1",
  ]);
});

test("a database with the guard turned off is left alone", async () => {
  await seedDatabase(db, { id: "db_1", teamId: TEAM_A, serverId: SERVER_1 });
  await db
    .update(databasesTable)
    .set({ restartLoopGuard: false })
    .where(eq(databasesTable.id, "db_1"));
  assert.deepEqual(await ids(guardedDatabases(SERVER_1, ["db_1"])), []);
});
