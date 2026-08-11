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
import {
  seedIdentity,
  TEAM_A,
  TRUNCATE_IDENTITY,
  USER_1,
} from "./identity-test-helpers";
import { seedApp, seedServer, SERVER_1 } from "./app-graph-test-helpers";
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
  deleteAllBackupArtifacts,
  cancelBackupRun,
  deleteBackup,
  deleteBackupRun,
  downloadBackupArtifact,
  listBackupRuns,
  reconcileInFlightBackupRuns,
  runBackup,
  runDatabaseBackup,
  sweepOrphanedBackupArtifacts,
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
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      // Holds the whole backup surface EXCEPT the one destructive verb, which is
      // the split `delete_backups` exists to make.
      {
        id: USER_SCHEDULER,
        teamId: TEAM_A,
        role: "member",
        capabilities: ["view", "manage_backups", "restore_backups"],
      },
      {
        id: USER_RESTORER,
        teamId: TEAM_A,
        role: "member",
        capabilities: ["view", "restore_backups"],
      },
    ],
  });
  await seedServer(db);
  await seedDatabase(db, { id: "db_1", name: "main" });
  await seedApp(db, { id: "prj_1", teamId: TEAM_A });
  await seedS3(db, { id: "s3_1" });
});

const asUser1 = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);

/** A member who may schedule and restore backups but not destroy one. */
const USER_SCHEDULER = "user_scheduler";
/** A member who may restore a backup but not schedule, run or stop one. */
const USER_RESTORER = "user_restorer";

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
      retentionCount: 7,
    });
    assert.equal(dto.targetKind, "database");
    assert.equal(dto.databaseName, "main");
    assert.equal(dto.serviceName, null);
    assert.equal(dto.destinationName, "s3_1");
    // Feeds the "same disk as this database" warning in the edit dialog.
    assert.equal(dto.targetServerId, SERVER_1);
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
          name: "x", targetKind: "database", databaseId: "db_missing",
          destinationId: "s3_1", schedule: "0 3 * * *", retentionCount: 7,
        }),
      /Database not found/,
    );
    await assert.rejects(
      () =>
        createBackup({
          name: "x", targetKind: "database", databaseId: "db_1",
          destinationId: "s3_missing", schedule: "0 3 * * *", retentionCount: 7,
        }),
      /Select a destination/,
    );
  });
});

test("an unparseable cron is rejected, not stored — on create and on edit", async () => {
  // `cronMatches` treats a bad expression as "never matches", so storing one
  // would be a schedule the UI reports as enabled and that never fires.
  await seedBackup(db, { id: "bkp_1", destinationId: "s3_1", databaseId: "db_1" });
  await asUser1(async () => {
    await assert.rejects(
      () =>
        createBackup({
          name: "x", targetKind: "database", databaseId: "db_1",
          destinationId: "s3_1", schedule: "every day at 3", retentionCount: 7,
        }),
      /not a valid cron expression/,
    );
    await assert.rejects(
      () =>
        updateBackup("bkp_1", {
          name: "x", destinationId: "s3_1", schedule: "0 99 * * *", retentionCount: 7,
        }),
      /not a valid cron expression/,
    );
    // An OMITTED schedule is "didn't choose", not "chose something broken" — it
    // still falls back to the daily default.
    const dto = await createBackup({
      name: "defaulted", targetKind: "database", databaseId: "db_1",
      destinationId: "s3_1", schedule: "", retentionCount: 7,
    });
    assert.equal(dto.schedule, "0 3 * * *");
  });
  const row = (await db.select().from(backupsTable).where(eq(backupsTable.id, "bkp_1")))[0]!;
  assert.equal(row.schedule, "0 3 * * *", "the rejected edit must not have landed");
});

test("toggleBackup / updateBackup / deleteBackup", async () => {
  await seedBackup(db, { id: "bkp_1", destinationId: "s3_1", databaseId: "db_1" });
  await seedS3(db, { id: "s3_2", name: "second" });
  await asUser1(async () => {
    await toggleBackup("bkp_1", false);
    const updated = await updateBackup("bkp_1", {
      name: "renamed", destinationId: "s3_2", schedule: "0 5 * * *", retentionCount: 30,
    });
    assert.equal(updated.name, "renamed");
    assert.equal(updated.destinationName, "second");
    assert.equal(updated.retentionCount, 30);
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

/* ------------------------------------------------------------------ */
/* Orphaned artifacts: a deleted target must not leak disk forever      */
/* ------------------------------------------------------------------ */

test("a deleted target's runs stay findable, and the sweep stamps them", async () => {
  // The FKs on backup_runs are ON DELETE SET NULL, so deleting an app used to
  // blank the only columns naming what its artifacts belonged to: retention
  // stopped seeing them, no screen listed them, and the files sat on the
  // destination forever with nothing left that could name them. `target_id` is
  // what survives.
  await seedRun(db, {
    id: "r_1",
    destinationId: "s3_1",
    appId: "prj_1",
    targetKind: "app",
    startedAt: "2020-01-01T00:00:00.000Z",
  });
  await pg.exec(`delete from apps where id = 'prj_1';`);

  const [row] = await db
    .select()
    .from(backupRunsTable)
    .where(eq(backupRunsTable.id, "r_1"));
  assert.equal(row!.appId, null, "the FK really is blanked by the delete");
  assert.equal(row!.targetId, "prj_1", "target_id survives it");
  assert.equal(row!.orphanedAt, null, "nothing has noticed yet");

  // FIRST sighting: stamped, never deleted. The backup is two years old and the
  // app went a second ago — measuring the keep window from the RUN would expire
  // it immediately, which is the opposite of "keep the backup files".
  const reclaimed = await sweepOrphanedBackupArtifacts();
  assert.equal(reclaimed, 0, "the first sweep only starts the clock");
  const [stamped] = await db
    .select()
    .from(backupRunsTable)
    .where(eq(backupRunsTable.id, "r_1"));
  assert.ok(stamped!.orphanedAt, "orphaned_at is set");

  // And it does not move on the next pass, or the window would never elapse.
  await sweepOrphanedBackupArtifacts();
  const [again] = await db
    .select()
    .from(backupRunsTable)
    .where(eq(backupRunsTable.id, "r_1"));
  assert.equal(again!.orphanedAt, stamped!.orphanedAt, "the clock is not reset");
});

test("an artifact is only reclaimed once the keep window has elapsed", async () => {
  await seedRun(db, {
    id: "r_old",
    destinationId: "s3_1",
    appId: "prj_1",
    targetKind: "app",
    status: "failed", // owns no file, so the delete needs no agent
    startedAt: "2020-01-01T00:00:00.000Z",
    orphanedAt: "2020-01-02T00:00:00.000Z",
  });
  await pg.exec(`delete from apps where id = 'prj_1';`);
  await sweepOrphanedBackupArtifacts();
  const rows = await db
    .select()
    .from(backupRunsTable)
    .where(eq(backupRunsTable.id, "r_old"));
  assert.equal(rows.length, 0, "orphaned long enough, and it owned no file");
});

test("a successful orphan is kept until its artifact is confirmed gone", async () => {
  // The destination is unreachable in tests, so the delete fails and the record
  // stays: a record is only ever dropped once its file is confirmed gone.
  await seedRun(db, {
    id: "r_keep",
    destinationId: "s3_1",
    appId: "prj_1",
    targetKind: "app",
    startedAt: "2020-01-01T00:00:00.000Z",
    orphanedAt: "2020-01-02T00:00:00.000Z",
  });
  await pg.exec(`delete from apps where id = 'prj_1';`);
  assert.equal(await sweepOrphanedBackupArtifacts(), 0);
  const rows = await db
    .select()
    .from(backupRunsTable)
    .where(eq(backupRunsTable.id, "r_keep"));
  assert.equal(rows.length, 1, "kept so the next sweep retries");
});

test("the sweep never touches a LIVE target, however old its runs", async () => {
  // The only shape it looks for is "both FKs null", which is precisely what a
  // deleted target leaves behind. Age alone must never be enough — that would
  // make it a second, unasked-for retention policy.
  await seedRun(db, {
    id: "r_live",
    destinationId: "s3_1",
    appId: "prj_1",
    targetKind: "app",
    startedAt: "2020-01-01T00:00:00.000Z",
  });
  await sweepOrphanedBackupArtifacts();
  const [row] = await db
    .select()
    .from(backupRunsTable)
    .where(eq(backupRunsTable.id, "r_live"));
  assert.equal(row!.orphanedAt, null, "a live app's artifacts are not the sweep's business");
});

/* ------------------------------------------------------------------ */
/* Deleting a target's artifacts                                        */
/* ------------------------------------------------------------------ */

test("deleteAllBackupArtifacts (database) needs delete_databases, not manage_backups", async () => {
  // It wipes every restore point a database has, with no undo. `manage_backups`
  // reads as "create, edit, disable and run backup schedules" and is handed out
  // on that reading — whoever may destroy the database may destroy its backups,
  // and nobody else.
  // Re-seed the whole identity graph with a SECOND member who holds exactly the
  // capability the old gate accepted, and nothing that may destroy a database.
  await pg.exec(TRUNCATE_IDENTITY);
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      {
        id: "usr_backups",
        teamId: TEAM_A,
        role: "member",
        capabilities: ["view", "manage_backups"],
      },
    ],
  });
  // The identity truncate cascades through the team, so everything downstream is
  // re-seeded rather than assumed.
  await seedServer(db);
  await seedDatabase(db, { id: "db_1", name: "main" });
  await seedS3(db, { id: "s3_1" });
  await seedRun(db, { id: "r_1", destinationId: "s3_1", databaseId: "db_1" });

  await runWithIdentity({ userId: "usr_backups", teamId: TEAM_A }, async () => {
    await assert.rejects(
      () => deleteAllBackupArtifacts({ kind: "database", targetId: "db_1" }),
      /permission|not allowed|delete/i,
    );
  });
  // The run — and therefore the artifact it names — is untouched.
  const rows = await db
    .select()
    .from(backupRunsTable)
    .where(eq(backupRunsTable.id, "r_1"));
  assert.equal(rows.length, 1);
});

/* ------------------------------------------------------------------ */
/* Ad-hoc "Back up now"                                                */
/* ------------------------------------------------------------------ */

test("runDatabaseBackup refuses a target or destination this team does not own", async () => {
  // The gate runs before anything dials an agent, so both refusals are the data
  // layer's own answer and not an agent error in disguise.
  await asUser1(async () => {
    await assert.rejects(
      () => runDatabaseBackup("db_missing", "s3_1"),
      /Database not found/,
    );
    await assert.rejects(
      () => runDatabaseBackup("db_1", "s3_missing"),
      /Select a destination/,
    );
  });
});

test("runDatabaseBackup records a failed run rather than throwing past the executor", async () => {
  // No agent is reachable in-process, so the dump cannot start — the point is
  // that the attempt is still HISTORY: an ad-hoc database backup that failed
  // shows up in the same artifacts table a scheduled one does.
  await asUser1(async () => {
    await assert.rejects(() => runDatabaseBackup("db_1", "s3_1"));
    const runs = await listBackupRuns({ databaseId: "db_1" });
    assert.equal(runs.length, 1);
    assert.equal(runs[0]!.status, "failed");
    assert.equal(runs[0]!.backupId, null); // ad-hoc: no owning schedule
    assert.equal(runs[0]!.databaseId, "db_1");
  });
});

/* ------------------------------------------------------------------ */
/* Downloading an artifact that lives in a bucket                       */
/* ------------------------------------------------------------------ */

test("a bucket artifact is no longer refused: the download reaches the agent", async () => {
  await asUser1(async () => {
    await seedRun(db, {
      id: "brun_dl",
      destinationId: "s3_1",
      targetKind: "app",
      appId: "prj_1",
    });
    // The seeded server has no live agent, so this gets as far as the dial and
    // fails THERE. Which failure is the whole point: "this backup is in your
    // bucket, fetch it with your own credentials" was a refusal by design, and
    // it left the Download button dead for every team whose backups live in one.
    await assert.rejects(
      () => downloadBackupArtifact("brun_dl"),
      (e: Error) => {
        assert.doesNotMatch(e.message, /in your bucket/i);
        assert.match(e.message, /not provisioned|unreachable|too old/i);
        return true;
      },
    );
  });
});

test("a legacy plaintext bucket destination downloads by the same path", async () => {
  await asUser1(async () => {
    // No keypair, so its objects really are in the clear. The identity is empty,
    // the agent skips the age layer, and nothing here has to know the difference.
    await seedS3(db, { id: "s3_old", legacyPlaintext: true });
    await seedRun(db, {
      id: "brun_old",
      destinationId: "s3_old",
      targetKind: "app",
      appId: "prj_1",
    });
    await assert.rejects(
      () => downloadBackupArtifact("brun_old"),
      (e: Error) => {
        assert.doesNotMatch(e.message, /in your bucket/i);
        return true;
      },
    );
  });
});

test("an artifact whose app was deleted says WHICH server it lacks", async () => {
  await asUser1(async () => {
    // `app_id` is ON DELETE SET NULL, so a run outlives its target - and that
    // artifact is exactly the one somebody still wants. With no workload host
    // left, any provisioned agent could dial the bucket; this harness has none,
    // so the message must name that, not the deleted app.
    await seedRun(db, {
      id: "brun_orphan",
      destinationId: "s3_1",
      targetKind: "app",
      appId: null,
      targetId: "prj_gone",
    });
    await assert.rejects(
      () => downloadBackupArtifact("brun_orphan"),
      /No server on this instance can reach/,
    );
  });
});

/* ------------------------------------------------------------------ */
/* The size a download advertises                                      */
/* ------------------------------------------------------------------ */

test("a run keeps the decrypted size apart from the stored one", async () => {
  await asUser1(async () => {
    // The two are different numbers: the stored artifact carries an age header
    // plus a tag per 64 KiB chunk. Sending the stored one as Content-Length
    // would leave the browser waiting for bytes that never arrive.
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
    // A run taken before the agent reported it advertises no length at all,
    // rather than the stored size, which would be wrong by the age overhead.
    assert.equal(legacy.decryptedSizeBytes, null);
  });
});


/* ------------------------------------------------------------------ */
/* Deleting one backup                                                 */
/* ------------------------------------------------------------------ */

test("a failed run leaves no file, so its record goes on its own", async () => {
  await asUser1(async () => {
    // The only shape that completes without an agent, and the one an operator
    // most often wants gone: a run that failed is a row of clutter.
    await seedRun(db, {
      id: "brun_failed",
      destinationId: "s3_1",
      targetKind: "app",
      appId: "prj_1",
      status: "failed",
      objectKey: "",
    });
    await deleteBackupRun("brun_failed");
    const left = await listBackupRuns({ appId: "prj_1" });
    assert.equal(left.length, 0);
  });
});

test("a file that could not be deleted KEEPS its record", async () => {
  await asUser1(async () => {
    // The invariant retention follows too: a record dropped while its object
    // survives is an orphan nothing can name any more, because every sweep
    // starts from the row.
    await seedRun(db, {
      id: "brun_keep",
      destinationId: "s3_1",
      targetKind: "app",
      appId: "prj_1",
    });
    await assert.rejects(
      () => deleteBackupRun("brun_keep"),
      /not provisioned|unreachable|too old/,
    );
    const left = await listBackupRuns({ appId: "prj_1" });
    assert.deepEqual(
      left.map((r) => r.id),
      ["brun_keep"],
    );
  });
});

test("a running backup is refused rather than half-deleted", async () => {
  await asUser1(async () => {
    // Its artifact does not exist yet, so taking the row away would let the dump
    // land a file nothing on this instance could ever find again.
    await seedRun(db, {
      id: "brun_live",
      destinationId: "s3_1",
      targetKind: "app",
      appId: "prj_1",
      status: "running",
    });
    await assert.rejects(() => deleteBackupRun("brun_live"), /still running/);
    assert.equal((await listBackupRuns({ appId: "prj_1" })).length, 1);
  });
});

test("deleting a backup needs delete_backups, not manage_backups", async () => {
  // The whole reason it is its own capability: scheduling a dump and destroying
  // the last copy of one are not the same permission.
  await asUser1(() =>
    seedRun(db, {
      id: "brun_guarded",
      destinationId: "s3_1",
      targetKind: "app",
      appId: "prj_1",
      status: "failed",
      objectKey: "",
    }),
  );
  await runWithIdentity({ userId: USER_SCHEDULER, teamId: TEAM_A }, async () => {
    await assert.rejects(() => deleteBackupRun("brun_guarded"), /permission/i);
  });
  // Still there.
  await asUser1(async () => {
    assert.equal((await listBackupRuns({ appId: "prj_1" })).length, 1);
  });
});

/* ------------------------------------------------------------------ */
/* Stopping a backup that is running                                   */
/* ------------------------------------------------------------------ */

test("cancelling settles the run and the schedule at once", async () => {
  await asUser1(async () => {
    // The record is the half that must ALWAYS settle: the dump may be running in
    // another process, or in none at all, and the panel cannot sit on "Running"
    // waiting to find out.
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
    // The dump can land between the click and the write. Flipping a real restore
    // point to `canceled` would throw away an artifact that exists.
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
  // A member who may restore but not schedule cannot stop one either: starting
  // and stopping a dump are the same power, and it is `manage_backups`.
  await runWithIdentity({ userId: USER_RESTORER, teamId: TEAM_A }, async () => {
    await assert.rejects(() => cancelBackupRun("brun_guard"), /permission/i);
  });
  await asUser1(async () => {
    const [run] = await listBackupRuns({ appId: "prj_1" });
    assert.equal(run!.status, "running");
  });
});
