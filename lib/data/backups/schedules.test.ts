import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../../db/test-harness";
import { __setTestDb, __resetTestDb } from "../../db/client";
import { backups as backupsTable } from "../../db/schema/control-plane/backups";
import { SERVER_1 } from "../app-graph-test-helpers";
import { seedBackup, seedS3 } from "../backup-test-helpers";
import { asUser1, seedBase } from "./backups-test-helpers";
import {
  createBackup,
  deleteBackup,
  toggleBackup,
  updateBackup,
} from "./schedules";

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

beforeEach(() => seedBase(db, pg));

test("createBackup (database) inserts a schedule and resolves names in the DTO", async () => {
  await asUser1(async () => {
    const dto = await createBackup({
      name: "nightly",
      targetKind: "database",
      databaseId: "db_1",
      destinationId: "s3_1",
      schedule: "0 3 * * *",
      retentionCount: 7,
    });
    assert.equal(dto.targetKind, "database");
    assert.equal(dto.databaseName, "main");
    assert.equal(dto.serviceName, null);
    assert.equal(dto.destinationName, "s3_1");
    assert.equal(dto.targetServerId, SERVER_1);
  });
  const rows = await db.select().from(backupsTable);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.databaseId, "db_1");
  assert.equal(rows[0]!.appId, null);
});

test("createBackup (project) sets only the project target", async () => {
  await asUser1(async () => {
    const dto = await createBackup({
      name: "prj-nightly",
      targetKind: "app",
      databaseId: null,
      appId: "prj_1",
      destinationId: "s3_1",
      schedule: "0 4 * * *",
      retentionCount: 14,
    });
    assert.equal(dto.serviceName, "prj_1");
    assert.equal(dto.databaseName, null);
    assert.equal(dto.targetServerId, SERVER_1);
  });
  const rows = await db.select().from(backupsTable);
  assert.equal(rows[0]!.appId, "prj_1");
  assert.equal(rows[0]!.databaseId, null);
});

test("createBackup rejects an unknown target / foreign destination", async () => {
  await asUser1(async () => {
    await assert.rejects(
      () =>
        createBackup({
          name: "x",
          targetKind: "database",
          databaseId: "db_missing",
          destinationId: "s3_1",
          schedule: "0 3 * * *",
          retentionCount: 7,
        }),
      /Database not found/,
    );
    await assert.rejects(
      () =>
        createBackup({
          name: "x",
          targetKind: "database",
          databaseId: "db_1",
          destinationId: "s3_missing",
          schedule: "0 3 * * *",
          retentionCount: 7,
        }),
      /Select a destination/,
    );
  });
});

test("an unparseable cron is rejected, not stored - on create and on edit", async () => {
  await seedBackup(db, {
    id: "bkp_1",
    destinationId: "s3_1",
    databaseId: "db_1",
  });
  await asUser1(async () => {
    await assert.rejects(
      () =>
        createBackup({
          name: "x",
          targetKind: "database",
          databaseId: "db_1",
          destinationId: "s3_1",
          schedule: "every day at 3",
          retentionCount: 7,
        }),
      /not a valid cron expression/,
    );
    await assert.rejects(
      () =>
        updateBackup("bkp_1", {
          name: "x",
          destinationId: "s3_1",
          schedule: "0 99 * * *",
          retentionCount: 7,
        }),
      /not a valid cron expression/,
    );
    const dto = await createBackup({
      name: "defaulted",
      targetKind: "database",
      databaseId: "db_1",
      destinationId: "s3_1",
      schedule: "",
      retentionCount: 7,
    });
    assert.equal(dto.schedule, "0 3 * * *");
  });
  const row = (
    await db.select().from(backupsTable).where(eq(backupsTable.id, "bkp_1"))
  )[0]!;
  assert.equal(
    row.schedule,
    "0 3 * * *",
    "the rejected edit must not have landed",
  );
});

test("toggleBackup / updateBackup / deleteBackup", async () => {
  await seedBackup(db, {
    id: "bkp_1",
    destinationId: "s3_1",
    databaseId: "db_1",
  });
  await seedS3(db, { id: "s3_2", name: "second" });
  await asUser1(async () => {
    await toggleBackup("bkp_1", false);
    const updated = await updateBackup("bkp_1", {
      name: "renamed",
      destinationId: "s3_2",
      schedule: "0 5 * * *",
      retentionCount: 30,
    });
    assert.equal(updated.name, "renamed");
    assert.equal(updated.destinationName, "second");
    assert.equal(updated.retentionCount, 30);
  });
  const row = (
    await db.select().from(backupsTable).where(eq(backupsTable.id, "bkp_1"))
  )[0]!;
  assert.equal(row.enabled, false);
  assert.equal(row.schedule, "0 5 * * *");

  await asUser1(() => deleteBackup("bkp_1"));
  assert.equal((await db.select().from(backupsTable)).length, 0);
});

test("a backup schedule fires at most every 15 minutes", async () => {
  await asUser1(async () => {
    for (const schedule of ["* * * * *", "*/5 * * * *", "0-30 * * * *"])
      await assert.rejects(
        () =>
          createBackup({
            name: "busy",
            targetKind: "database",
            databaseId: "db_1",
            destinationId: "s3_1",
            schedule,
            retentionCount: 7,
          }),
        /at most every 15 minutes/,
        schedule,
      );
    const ok = await createBackup({
      name: "half-hourly",
      targetKind: "database",
      databaseId: "db_1",
      destinationId: "s3_1",
      schedule: "0,30 * * * *",
      retentionCount: 7,
    });
    assert.equal(ok.schedule, "0,30 * * * *");
  });
});
