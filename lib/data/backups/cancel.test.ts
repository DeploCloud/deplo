import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../../db/test-harness";
import { __setTestDb, __resetTestDb } from "../../db/client";
import { backups as backupsTable } from "../../db/schema/control-plane/backups";
import { runWithIdentity } from "../../auth/request-context";
import { TEAM_A } from "../identity-test-helpers";
import { seedBackup, seedRun } from "../backup-test-helpers";
import { asUser1, seedBase, USER_RESTORER } from "./backups-test-helpers";
import { cancelBackupRun } from "./execute-backup";
import { listBackupRuns } from "./run-listing";

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

test("cancelling settles the run and the schedule at once", async () => {
  await asUser1(async () => {
    await seedBackup(db, {
      id: "bkp_live",
      destinationId: "s3_1",
      targetKind: "app",
      appId: "prj_1",
    });
    await seedRun(db, {
      id: "brun_going",
      destinationId: "s3_1",
      backupId: "bkp_live",
      targetKind: "app",
      appId: "prj_1",
      status: "running",
    });
    assert.equal(await cancelBackupRun("brun_going"), true);
    const [run] = await listBackupRuns({ appId: "prj_1" });
    assert.equal(run!.status, "canceled");
    assert.match(run!.error ?? "", /Canceled by/);
    assert.ok(run!.finishedAt, "a stopped run is finished, not left open");
    const [schedule] = await db
      .select()
      .from(backupsTable)
      .where(eq(backupsTable.id, "bkp_live"));
    assert.equal(schedule!.lastStatus, "canceled");
  });
});

test("cancelling a backup that already finished changes nothing", async () => {
  await asUser1(async () => {
    await seedRun(db, {
      id: "brun_done",
      destinationId: "s3_1",
      targetKind: "app",
      appId: "prj_1",
      status: "success",
    });
    assert.equal(await cancelBackupRun("brun_done"), false);
    const [run] = await listBackupRuns({ appId: "prj_1" });
    assert.equal(run!.status, "success");
    assert.equal(run!.error, null);
  });
});

test("stopping a backup needs manage_backups", async () => {
  await asUser1(() =>
    seedRun(db, {
      id: "brun_guard",
      destinationId: "s3_1",
      targetKind: "app",
      appId: "prj_1",
      status: "running",
    }),
  );
  await runWithIdentity({ userId: USER_RESTORER, teamId: TEAM_A }, async () => {
    await assert.rejects(() => cancelBackupRun("brun_guard"), /permission/i);
  });
  await asUser1(async () => {
    const [run] = await listBackupRuns({ appId: "prj_1" });
    assert.equal(run!.status, "running");
  });
});
