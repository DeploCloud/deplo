import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import {
  backups as backupsTable,
  backupRuns as backupRunsTable,
} from "../db/schema/control-plane";
import { runWithIdentity } from "../auth/request-context";
import { seedIdentity, TEAM_A, USER_1 } from "./identity-test-helpers";
import { seedApp, seedServer } from "./app-graph-test-helpers";
import {
  seedBackup,
  seedDatabase,
  seedRun,
  seedS3,
  TRUNCATE_BACKUPS,
} from "./backup-test-helpers";
import {
  backupDestinationsForTarget,
  countBackupArtifacts,
  createBackup,
  deleteBackup,
  listBackupRuns,
  reconcileInFlightBackupRuns,
  runBackup,
  toggleBackup,
  updateBackup,
} from "./backups";

/**
 * Data-layer tests for `backups` against pglite (PLAN Step 5, cut-set (d)). Covers
 * the CRUD + validation (the target_kind XOR), the seq-ordered run list, the
 * distinct-destinations sweep helper, the two-tx executor recording a `failed`
 * run when it can't even resolve creds (no agent reached), and the boot reconcile
 * that flips stale `running` runs (+ stuck schedules) to `failed`.
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

const T0 = "2026-01-01T00:00:00.000Z";

beforeEach(async () => {
  await pg.exec(`${TRUNCATE_BACKUPS}
    truncate table app_build_method_settings, app_build, apps, servers,
      users, teams restart identity cascade;`);
  await seedIdentity(db, { users: [{ id: USER_1, teamId: TEAM_A, role: "owner" }] });
  await seedServer(db);
  await seedDatabase(db, { id: "db_1", name: "main" });
  await seedApp(db, { id: "prj_1", teamId: TEAM_A });
  await seedS3(db, { id: "s3_1" });
});

const asUser1 = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);

/* ------------------------------------------------------------------ */
/* CRUD + validation                                                   */
/* ------------------------------------------------------------------ */

test("createBackup (database) inserts a schedule and resolves names in the DTO", async () => {
  await asUser1(async () => {
    const dto = await createBackup({
      name: "nightly",
      targetKind: "database",
      databaseId: "db_1",
      destinationId: "s3_1",
      schedule: "0 3 * * *",
      retentionDays: 7,
    });
    assert.equal(dto.targetKind, "database");
    assert.equal(dto.databaseName, "main");
    assert.equal(dto.serviceName, null);
    assert.equal(dto.destinationName, "s3_1");
  });
  // The row holds the XOR-consistent target (database set, project null).
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
      retentionDays: 14,
    });
    assert.equal(dto.serviceName, "prj_1");
    assert.equal(dto.databaseName, null);
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
          name: "x", targetKind: "database", databaseId: "db_missing",
          destinationId: "s3_1", schedule: "0 3 * * *", retentionDays: 7,
        }),
      /Database not found/,
    );
    await assert.rejects(
      () =>
        createBackup({
          name: "x", targetKind: "database", databaseId: "db_1",
          destinationId: "s3_missing", schedule: "0 3 * * *", retentionDays: 7,
        }),
      /Select a destination/,
    );
  });
});

test("toggleBackup / updateBackup / deleteBackup", async () => {
  await seedBackup(db, { id: "bkp_1", destinationId: "s3_1", databaseId: "db_1" });
  await seedS3(db, { id: "s3_2", name: "second" });
  await asUser1(async () => {
    await toggleBackup("bkp_1", false);
    const updated = await updateBackup("bkp_1", {
      name: "renamed", destinationId: "s3_2", schedule: "0 5 * * *", retentionDays: 30,
    });
    assert.equal(updated.name, "renamed");
    assert.equal(updated.destinationName, "second");
    assert.equal(updated.retentionDays, 30);
  });
  const row = (await db.select().from(backupsTable).where(eq(backupsTable.id, "bkp_1")))[0]!;
  assert.equal(row.enabled, false);
  assert.equal(row.schedule, "0 5 * * *");

  await asUser1(() => deleteBackup("bkp_1"));
  assert.equal((await db.select().from(backupsTable)).length, 0);
});

/* ------------------------------------------------------------------ */
/* Run list ordering (seq tiebreak) + destination sweep                */
/* ------------------------------------------------------------------ */

test("listBackupRuns is newest-first by (startedAt, seq) — deterministic under a tie", async () => {
  // Three runs at the SAME instant; insertion order (seq) decides newest-first.
  await seedRun(db, { id: "r1", destinationId: "s3_1", databaseId: "db_1", startedAt: T0 });
  await seedRun(db, { id: "r2", destinationId: "s3_1", databaseId: "db_1", startedAt: T0 });
  await seedRun(db, { id: "r3", destinationId: "s3_1", databaseId: "db_1", startedAt: T0 });
  await asUser1(async () => {
    const runs = await listBackupRuns({ databaseId: "db_1" });
    assert.deepEqual(runs.map((r) => r.id), ["r3", "r2", "r1"], "highest seq first");
  });
});

test("backupDestinationsForTarget returns the distinct buckets a target ran to", async () => {
  await seedS3(db, { id: "s3_2", name: "second" });
  await seedRun(db, { id: "r1", destinationId: "s3_1", databaseId: "db_1" });
  await seedRun(db, { id: "r2", destinationId: "s3_1", databaseId: "db_1" });
  await seedRun(db, { id: "r3", destinationId: "s3_2", databaseId: "db_1" });
  await asUser1(async () => {
    const dests = await backupDestinationsForTarget({ kind: "database", targetId: "db_1" });
    assert.deepEqual([...dests].sort(), ["s3_1", "s3_2"]);
  });
});

test("countBackupArtifacts counts only SUCCESSFUL runs of the given target", async () => {
  // Two stored artifacts (success), plus a failed + a running run that left no
  // object — and an artifact for a DIFFERENT target that must not leak in.
  await seedRun(db, { id: "r_ok1", destinationId: "s3_1", databaseId: "db_1", status: "success" });
  await seedRun(db, { id: "r_ok2", destinationId: "s3_1", databaseId: "db_1", status: "success" });
  await seedRun(db, { id: "r_fail", destinationId: "s3_1", databaseId: "db_1", status: "failed" });
  await seedRun(db, { id: "r_run", destinationId: "s3_1", databaseId: "db_1", status: "running" });
  await seedRun(db, { id: "r_app", destinationId: "s3_1", appId: "prj_1", targetKind: "app", status: "success" });
  await asUser1(async () => {
    assert.equal(
      await countBackupArtifacts({ kind: "database", targetId: "db_1" }),
      2,
      "only the two successful database runs count",
    );
    assert.equal(
      await countBackupArtifacts({ kind: "app", targetId: "prj_1" }),
      1,
      "the app's own successful run",
    );
  });
});

test("countBackupArtifacts is 0 for a target with no stored artifacts", async () => {
  // A target that only ever failed has nothing in S3 → the delete dialog hides
  // its 'also delete backup artifacts' checkbox (the reported bug).
  await seedRun(db, { id: "r_fail", destinationId: "s3_1", databaseId: "db_1", status: "failed" });
  await asUser1(async () => {
    assert.equal(await countBackupArtifacts({ kind: "database", targetId: "db_1" }), 0);
    assert.equal(await countBackupArtifacts({ kind: "app", targetId: "prj_1" }), 0);
  });
});

/* ------------------------------------------------------------------ */
/* The two-tx executor records start + terminal with no agent reached   */
/* ------------------------------------------------------------------ */

test("runBackup records a failed run when the owning agent is unreachable", async () => {
  // A valid schedule against a real destination + database: the start tx persists
  // a `running` run + stamps the schedule, the DB descriptor resolves with no
  // network, then the agent dial fails (the seeded server has no live agent) →
  // the terminal tx flips the run to `failed`. Proves BOTH short transactions run
  // around the (failed) agent call, with the dial OUTSIDE either tx.
  await seedBackup(db, { id: "bkp_1", destinationId: "s3_1", databaseId: "db_1" });
  await asUser1(async () => {
    await assert.rejects(() => runBackup("bkp_1"));
    const runs = await listBackupRuns({ databaseId: "db_1" });
    assert.equal(runs.length, 1, "the run was recorded (start tx)");
    assert.equal(runs[0]!.status, "failed", "flipped failed (terminal tx)");
    assert.ok(runs[0]!.finishedAt, "finishedAt stamped");
  });
  // The schedule's lastStatus settled to failed via the terminal transaction.
  const b = (await db.select().from(backupsTable).where(eq(backupsTable.id, "bkp_1")))[0]!;
  assert.equal(b.lastStatus, "failed");
  assert.ok(b.lastRunAt, "lastRunAt stamped by the start tx");
});

/* ------------------------------------------------------------------ */
/* Boot reconcile                                                       */
/* ------------------------------------------------------------------ */

test("reconcileInFlightBackupRuns flips stale running runs + stuck schedules to failed", async () => {
  await seedBackup(db, { id: "bkp_1", destinationId: "s3_1", databaseId: "db_1" });
  await db
    .update(backupsTable)
    .set({ lastStatus: "running" })
    .where(eq(backupsTable.id, "bkp_1"));

  // An OLD running run (orphaned by a restart) + a FRESH running run (genuinely
  // in flight — must be left alone).
  await seedRun(db, {
    id: "r_old", destinationId: "s3_1", databaseId: "db_1", backupId: "bkp_1",
    status: "running", startedAt: "2020-01-01T00:00:00.000Z", finishedAt: null,
  });
  await seedRun(db, {
    id: "r_fresh", destinationId: "s3_1", databaseId: "db_1", backupId: "bkp_1",
    status: "running", startedAt: new Date().toISOString(), finishedAt: null,
  });

  const n = await reconcileInFlightBackupRuns();
  assert.equal(n, 1, "exactly the orphaned run reconciled");

  const old = (await db.select().from(backupRunsTable).where(eq(backupRunsTable.id, "r_old")))[0]!;
  assert.equal(old.status, "failed");
  assert.ok(old.finishedAt, "finishedAt stamped");
  const fresh = (await db.select().from(backupRunsTable).where(eq(backupRunsTable.id, "r_fresh")))[0]!;
  assert.equal(fresh.status, "running", "a genuinely in-flight run is untouched");

  const b = (await db.select().from(backupsTable).where(eq(backupsTable.id, "bkp_1")))[0]!;
  assert.equal(b.lastStatus, "failed", "the stuck schedule settled");
});

test("reconcileInFlightBackupRuns is idempotent / a no-op with nothing stale", async () => {
  await seedRun(db, {
    id: "r1", destinationId: "s3_1", databaseId: "db_1", status: "success",
  });
  assert.equal(await reconcileInFlightBackupRuns(), 0);
});
