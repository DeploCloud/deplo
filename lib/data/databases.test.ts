import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import {
  backups as backupsTable,
  backupRuns as backupRunsTable,
  databases as databasesTable,
} from "../db/schema/control-plane";
import { runWithIdentity } from "../auth/request-context";
import { seedIdentity, TEAM_A, TEAM_B, USER_1 } from "./identity-test-helpers";
import { seedServer } from "./project-graph-test-helpers";
import { seedBackup, seedDatabase, seedRun, seedS3, TRUNCATE_BACKUPS } from "./backup-test-helpers";
import {
  getConnectionString,
  getDatabase,
  listDatabases,
  deleteDatabase,
} from "./databases";

/**
 * Data-layer tests for `databases` against pglite (PLAN Step 5, cut-set (d)).
 * Verifies the newest-first SQL list, team isolation, the masked DTO / decrypted
 * connection string, and — the headline — that `deleteDatabase` removes the row
 * with the agent teardown OUTSIDE the delete, and the DB FKs CASCADE dependent
 * backup schedules + SET NULL a run's databaseId (the orphan the JSONB version
 * hand-filtered).
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
  await pg.exec(`${TRUNCATE_BACKUPS}
    truncate table users, teams restart identity cascade;`);
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      { id: "user_2", teamId: TEAM_B, role: "owner" },
    ],
  });
  await seedServer(db);
});

const asUser1 = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);

test("listDatabases is team-scoped, newest-first, and masks the connection string", async () => {
  await seedDatabase(db, { id: "db_old", name: "old" });
  // A newer row (later createdAt) must sort first.
  await db
    .update(databasesTable)
    .set({ createdAt: "2026-02-01T00:00:00.000Z" })
    .where(eq(databasesTable.id, "db_old"));
  await seedDatabase(db, { id: "db_new", name: "new" });
  await db
    .update(databasesTable)
    .set({ createdAt: "2026-03-01T00:00:00.000Z" })
    .where(eq(databasesTable.id, "db_new"));
  // A foreign-team database is invisible.
  await seedDatabase(db, { id: "db_other", teamId: TEAM_B, name: "other" });

  await asUser1(async () => {
    const list = await listDatabases();
    assert.deepEqual(list.map((d) => d.id), ["db_new", "db_old"]);
    assert.equal("connectionStringEnc" in list[0]!, false, "no secret in the DTO");
    assert.ok(list[0]!.connectionStringMasked.includes("••••"), "password masked");
  });
});

test("getConnectionString decrypts; getDatabase is team-scoped", async () => {
  await seedDatabase(db, { id: "db_1", name: "main" });
  await asUser1(async () => {
    const conn = await getConnectionString("db_1");
    assert.ok(conn.startsWith("postgres://"), "decrypted plaintext");
    assert.ok((await getDatabase("db_1")) !== null);
  });
  // user_2 (team B) cannot see team A's database.
  await runWithIdentity({ userId: "user_2", teamId: TEAM_B }, async () => {
    assert.equal(await getDatabase("db_1"), null);
    await assert.rejects(() => getConnectionString("db_1"), /Not found/);
  });
});

test("deleteDatabase cascades schedules and SET NULLs run history (no orphans)", async () => {
  await seedDatabase(db, { id: "db_1", name: "main" });
  const s3 = await seedS3(db, { id: "s3_1" });
  // A schedule targeting the db (CASCADE) + a run referencing it (SET NULL).
  await seedBackup(db, { id: "bkp_1", destinationId: s3, databaseId: "db_1" });
  await seedRun(db, { id: "brun_1", destinationId: s3, databaseId: "db_1", backupId: "bkp_1" });

  // The seeded server has no live agent, so the teardown dial fails — best-effort:
  // the row is still deleted (and an orphan warning logged). This also proves the
  // agent call is OUTSIDE the delete (a thrown dial can't roll the delete back).
  await asUser1(() => deleteDatabase("db_1"));

  assert.equal(
    (await db.select().from(databasesTable).where(eq(databasesTable.id, "db_1"))).length,
    0,
    "database row deleted",
  );
  assert.equal(
    (await db.select().from(backupsTable).where(eq(backupsTable.id, "bkp_1"))).length,
    0,
    "dependent schedule CASCADE-deleted",
  );
  const run = await db.select().from(backupRunsTable).where(eq(backupRunsTable.id, "brun_1"));
  assert.equal(run.length, 1, "run history survives");
  assert.equal(run[0]!.databaseId, null, "run.databaseId SET NULL");
});
