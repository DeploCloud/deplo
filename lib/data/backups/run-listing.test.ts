import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";

import { makeTestDb, type TestDb } from "../../db/test-harness";
import { __setTestDb, __resetTestDb } from "../../db/client";
import { seedBackup, seedDatabase, seedRun } from "../backup-test-helpers";
import { asUser1, seedBase } from "./backups-test-helpers";
import { getDatabaseBackupSummary, listBackupRuns } from "./run-listing";
import { listBackups } from "./schedules";

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

const T0 = "2026-01-01T00:00:00.000Z";

beforeEach(() => seedBase(db, pg));

test("listBackupRuns is newest-first by (startedAt, seq) - deterministic under a tie", async () => {
  await seedRun(db, {
    id: "r1",
    destinationId: "s3_1",
    databaseId: "db_1",
    startedAt: T0,
  });
  await seedRun(db, {
    id: "r2",
    destinationId: "s3_1",
    databaseId: "db_1",
    startedAt: T0,
  });
  await seedRun(db, {
    id: "r3",
    destinationId: "s3_1",
    databaseId: "db_1",
    startedAt: T0,
  });
  await asUser1(async () => {
    const runs = await listBackupRuns({ databaseId: "db_1" });
    assert.deepEqual(
      runs.map((r) => r.id),
      ["r3", "r2", "r1"],
      "highest seq first",
    );
  });
});

test("a run keeps the decrypted size apart from the stored one", async () => {
  await asUser1(async () => {
    await seedRun(db, {
      id: "brun_sized",
      destinationId: "s3_1",
      targetKind: "app",
      appId: "prj_1",
      decryptedSizeBytes: 900,
    });
    await seedRun(db, {
      id: "brun_legacy",
      destinationId: "s3_1",
      targetKind: "app",
      appId: "prj_1",
    });
    const runs = await listBackupRuns({ appId: "prj_1" });
    const sized = runs.find((r) => r.id === "brun_sized")!;
    const legacy = runs.find((r) => r.id === "brun_legacy")!;
    assert.equal(sized.decryptedSizeBytes, 900);
    assert.notEqual(sized.decryptedSizeBytes, sized.sizeBytes);
    assert.equal(legacy.decryptedSizeBytes, null);
  });
});

test("listBackups carries the size of the newest artifact each schedule still holds", async () => {
  await seedBackup(db, {
    id: "bkp_1",
    destinationId: "s3_1",
    databaseId: "db_1",
  });
  await seedBackup(db, {
    id: "bkp_2",
    destinationId: "s3_1",
    databaseId: "db_1",
  });
  await seedRun(db, {
    id: "r_old",
    backupId: "bkp_1",
    destinationId: "s3_1",
    databaseId: "db_1",
    sizeBytes: 1024,
  });
  await seedRun(db, {
    id: "r_new",
    backupId: "bkp_1",
    destinationId: "s3_1",
    databaseId: "db_1",
    sizeBytes: 4096,
  });
  await seedRun(db, {
    id: "r_bad",
    backupId: "bkp_1",
    destinationId: "s3_1",
    databaseId: "db_1",
    sizeBytes: 9999,
    status: "failed",
  });

  await asUser1(async () => {
    const byId = new Map((await listBackups()).map((b) => [b.id, b]));
    assert.equal(byId.get("bkp_1")!.databaseType, "postgres");
    assert.equal(byId.get("bkp_1")!.databaseName, "main");
    assert.equal(byId.get("bkp_1")!.lastSizeBytes, 4096);
    assert.equal(byId.get("bkp_2")!.lastSizeBytes, null);
  });
});

test("getDatabaseBackupSummary carries only this database's schedules and runs", async () => {
  await seedDatabase(db, { id: "db_2", name: "other" });
  await seedBackup(db, {
    id: "bkp_1",
    destinationId: "s3_1",
    databaseId: "db_1",
  });
  await seedBackup(db, {
    id: "bkp_other",
    destinationId: "s3_1",
    databaseId: "db_2",
  });
  await seedRun(db, {
    id: "r_1",
    backupId: "bkp_1",
    destinationId: "s3_1",
    databaseId: "db_1",
    startedAt: "2026-02-01T00:00:00.000Z",
  });
  await seedRun(db, {
    id: "r_other",
    backupId: "bkp_other",
    destinationId: "s3_1",
    databaseId: "db_2",
    startedAt: "2026-03-01T00:00:00.000Z",
  });

  await asUser1(async () => {
    const s = await getDatabaseBackupSummary("db_1");
    assert.deepEqual(
      s.schedules.map((b) => b.id),
      ["bkp_1"],
    );
    assert.equal(s.lastRunAt, "2026-02-01T00:00:00.000Z");
    assert.equal(s.lastStatus, "success");
  });
});

test("getDatabaseBackupSummary is empty for a database with nothing", async () => {
  await asUser1(async () => {
    const s = await getDatabaseBackupSummary("db_1");
    assert.deepEqual(s.schedules, []);
    assert.equal(s.lastRunAt, null);
    assert.equal(s.lastStatus, null);
  });
});

test("getDatabaseBackupSummary counts an ad-hoc run as the last run", async () => {
  await seedBackup(db, {
    id: "bkp_1",
    destinationId: "s3_1",
    databaseId: "db_1",
  });
  await seedRun(db, {
    id: "r_sched",
    backupId: "bkp_1",
    destinationId: "s3_1",
    databaseId: "db_1",
    startedAt: "2026-02-01T00:00:00.000Z",
  });
  await seedRun(db, {
    id: "r_adhoc",
    backupId: null,
    destinationId: "s3_1",
    databaseId: "db_1",
    startedAt: "2026-02-02T00:00:00.000Z",
    status: "failed",
  });

  await asUser1(async () => {
    const s = await getDatabaseBackupSummary("db_1");
    assert.equal(s.lastRunAt, "2026-02-02T00:00:00.000Z");
    assert.equal(s.lastStatus, "failed");
  });
});
