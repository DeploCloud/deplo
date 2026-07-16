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
import { seedServer } from "./app-graph-test-helpers";
import { seedBackup, seedDatabase, seedRun, seedS3, TRUNCATE_BACKUPS } from "./backup-test-helpers";
import {
  getConnectionString,
  getDatabase,
  listDatabases,
  deleteDatabase,
  dbVolumeHostName,
  updateDatabaseResources,
  updateDatabaseImage,
  restartDatabase,
  redeployDatabase,
  rebuildDatabase,
  rotateDatabasePassword,
  reorderDatabases,
} from "./databases";
import { generateDatabaseCompose } from "../deploy/database-compose";
import { composeStackVolumeHostNames } from "./project-backup-descriptor";

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

// The cross-host volume copy that backs a server MOVE operates on the DB's real
// host-side Docker volume name. dbVolumeHostName must equal what the rendered DB
// compose ACTUALLY produces on the host, or a move would export/import the wrong
// (non-existent) volume and silently migrate nothing. Pin it AND cross-check it
// against the compose renderer + the same prefix logic project backups use, so the
// three can never drift.
test("dbVolumeHostName matches the rendered DB compose volume (move copies the right volume)", () => {
  const slug = "db-mydb";
  // The literal contract the agent's ExportVolume/ImportVolume receive.
  assert.equal(dbVolumeHostName(slug), "deplo-db-mydb_db-mydb-data");

  // Cross-check: derive the host volume name(s) from the ACTUAL rendered compose
  // exactly as buildProjectDescriptor does for a compose-stack backup. The DB
  // stack declares one unnamed volume, so this yields the single data volume — and
  // it must equal dbVolumeHostName. If someone changes the compose (e.g. pins a
  // `name:` on the volume), this fails loudly instead of breaking moves silently.
  const yaml = generateDatabaseCompose({
    name: slug,
    databaseId: "db_test",
    type: "postgres",
    version: "16",
    username: "app",
    password: "pw",
    dbName: "db-mydb",
  });
  const derived = composeStackVolumeHostNames(slug, yaml);
  assert.deepEqual(derived, [dbVolumeHostName(slug)]);
});

/* ------------------------------------------------------------------ */
/* Focused post-create mutations (the database detail page)            */
/* ------------------------------------------------------------------ */

test("updateDatabaseResources: validates, persists, and round-trips via the DTO", async () => {
  await seedDatabase(db, { id: "db_lim", name: "lim" });
  await asUser1(async () => {
    await updateDatabaseResources("db_lim", { memoryMb: 512, cpuMilli: 500 });
    const dto = await getDatabase("db_lim");
    assert.equal(dto?.resources?.memoryMb, 512);
    assert.equal(dto?.resources?.cpuMilli, 500);
    assert.equal(dto?.resources?.pidsLimit, null);

    // Clearing every field folds back to resources: null (no limits set).
    await updateDatabaseResources("db_lim", {});
    assert.equal((await getDatabase("db_lim"))?.resources, null);

    // The shared validator runs on this path too: swap without memory is the
    // apps rule, verbatim.
    await assert.rejects(
      updateDatabaseResources("db_lim", { swapMb: 1024 }),
      /memory limit before a swap limit/,
    );
  });
});

test("updateDatabaseResources: a cross-team id hits 0 rows (Not found)", async () => {
  await seedDatabase(db, { id: "db_foreign", teamId: TEAM_B, name: "foreign" });
  await asUser1(async () => {
    await assert.rejects(
      updateDatabaseResources("db_foreign", { memoryMb: 256 }),
      /Not found/,
    );
  });
});

test("updateDatabaseImage: set + clear round-trip, syntax rejected", async () => {
  await seedDatabase(db, { id: "db_img", name: "img" });
  await asUser1(async () => {
    await updateDatabaseImage("db_img", {
      customImage: "timescale/timescaledb:2-pg16",
      customCommand: "postgres -c shared_buffers=256MB",
      version: "16.3",
    });
    let dto = await getDatabase("db_img");
    assert.equal(dto?.customImage, "timescale/timescaledb:2-pg16");
    assert.equal(dto?.customCommand, "postgres -c shared_buffers=256MB");
    assert.equal(dto?.version, "16.3");

    // Explicit null clears; absent fields stay untouched.
    await updateDatabaseImage("db_img", { customImage: null });
    dto = await getDatabase("db_img");
    assert.equal(dto?.customImage, null);
    assert.equal(dto?.customCommand, "postgres -c shared_buffers=256MB");

    await assert.rejects(
      updateDatabaseImage("db_img", { customImage: "bad image ref" }),
      /plain image reference/,
    );
    await assert.rejects(
      updateDatabaseImage("db_img", { customCommand: "line1\nline2" }),
      /single line/,
    );
    await assert.rejects(
      updateDatabaseImage("db_img", { version: "not a tag!" }),
      /valid image tag/,
    );
  });
});

test("restart/redeploy/rebuild: gated while provisioning with the curated message", async () => {
  await seedDatabase(db, { id: "db_prov", name: "prov", status: "provisioning" });
  await asUser1(async () => {
    await assert.rejects(restartDatabase("db_prov"), /still provisioning/);
    await assert.rejects(redeployDatabase("db_prov"), /still provisioning/);
    await assert.rejects(rebuildDatabase("db_prov"), /still provisioning/);
  });
});

// The destructive rebuild dials the agent BEFORE any write: an unreachable
// host must fail clearly with the row (and its status) untouched — nothing was
// torn down, so flipping status would lie.
test("rebuildDatabase: unreachable agent fails clearly and leaves the row intact", async () => {
  await seedDatabase(db, { id: "db_rb", name: "rb" });
  await asUser1(async () => {
    await assert.rejects(rebuildDatabase("db_rb"));
    const dto = await getDatabase("db_rb");
    assert.ok(dto, "row survives the failed rebuild");
    assert.equal(dto.status, "running", "status untouched — nothing was torn down");
  });
});

test("rotateDatabasePassword: requires a running database and a quote-free password", async () => {
  await seedDatabase(db, { id: "db_rot", name: "rot", status: "stopped" });
  await asUser1(async () => {
    await assert.rejects(
      rotateDatabasePassword("db_rot"),
      /Start the database/,
    );
    await assert.rejects(
      rotateDatabasePassword("db_rot", { password: "with'quote" }),
      /quotes/,
    );
  });
});

test("focused mutations reject a member without manage_infra", async () => {
  // Re-seed identity with an extra low-capability member (the server row from
  // beforeEach survives the identity truncate — servers are cross-team).
  await pg.exec(`${TRUNCATE_BACKUPS}
    truncate table users, teams restart identity cascade;`);
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      { id: "user_viewer", teamId: TEAM_A, role: "member", capabilities: ["view"] },
    ],
  });
  await seedDatabase(db, { id: "db_cap", name: "cap" });
  await runWithIdentity({ userId: "user_viewer", teamId: TEAM_A }, async () => {
    await assert.rejects(updateDatabaseResources("db_cap", { memoryMb: 256 }));
    await assert.rejects(updateDatabaseImage("db_cap", { version: "16" }));
    await assert.rejects(restartDatabase("db_cap"));
    await assert.rejects(redeployDatabase("db_cap"));
    await assert.rejects(rebuildDatabase("db_cap"));
    await assert.rejects(rotateDatabasePassword("db_cap"));
  });
});

test("reorderDatabases persists a team order that listDatabases honours", async () => {
  // Three databases, created oldest→newest so the default sort is c, b, a.
  await seedDatabase(db, { id: "db_a", name: "aaa" });
  await db.update(databasesTable).set({ createdAt: "2026-01-01T00:00:00.000Z" }).where(eq(databasesTable.id, "db_a"));
  await seedDatabase(db, { id: "db_b", name: "bbb" });
  await db.update(databasesTable).set({ createdAt: "2026-02-01T00:00:00.000Z" }).where(eq(databasesTable.id, "db_b"));
  await seedDatabase(db, { id: "db_c", name: "ccc" });
  await db.update(databasesTable).set({ createdAt: "2026-03-01T00:00:00.000Z" }).where(eq(databasesTable.id, "db_c"));

  await asUser1(async () => {
    // Default: newest-first.
    assert.deepEqual((await listDatabases()).map((d) => d.id), ["db_c", "db_b", "db_a"]);

    // Persist an explicit order; listDatabases must follow it.
    await reorderDatabases(["db_a", "db_c", "db_b"]);
    assert.deepEqual((await listDatabases()).map((d) => d.id), ["db_a", "db_c", "db_b"]);

    // A partial order pins the listed ids first (in order); the omitted one
    // falls back to newest-first after them.
    await reorderDatabases(["db_b"]);
    assert.deepEqual((await listDatabases()).map((d) => d.id), ["db_b", "db_c", "db_a"]);

    // Unknown/foreign ids are dropped, not stored.
    await reorderDatabases(["db_nope", "db_a"]);
    assert.deepEqual((await listDatabases()).map((d) => d.id), ["db_a", "db_c", "db_b"]);
  });
});

test("reorderDatabases self-heals on delete (FK cascade) and rejects without manage_infra", async () => {
  await seedDatabase(db, { id: "db_x", name: "xxx" });
  await seedDatabase(db, { id: "db_y", name: "yyy" });
  await asUser1(async () => {
    await reorderDatabases(["db_y", "db_x"]);
    // Deleting an ordered database must not leave its id in the order table.
    await db.delete(databasesTable).where(eq(databasesTable.id, "db_y"));
    assert.deepEqual((await listDatabases()).map((d) => d.id), ["db_x"]);
  });

  // A member without manage_infra can't reorder.
  await pg.exec(`${TRUNCATE_BACKUPS}
    truncate table users, teams restart identity cascade;`);
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      { id: "user_viewer2", teamId: TEAM_A, role: "member", capabilities: ["view"] },
    ],
  });
  await seedDatabase(db, { id: "db_z", name: "zzz" });
  await runWithIdentity({ userId: "user_viewer2", teamId: TEAM_A }, async () => {
    await assert.rejects(reorderDatabases(["db_z"]));
  });
});
