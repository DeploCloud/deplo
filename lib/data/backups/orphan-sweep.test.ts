import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../../db/test-harness";
import { __setTestDb, __resetTestDb } from "../../db/client";
import {
  backups as backupsTable,
  backupRuns as backupRunsTable,
} from "../../db/schema/control-plane/backups";
import { seedBackup, seedRun } from "../backup-test-helpers";
import { seedBase } from "./backups-test-helpers";
import { activities } from "../../db/schema/control-plane/activity";
import { __setAgentConnectorForTest } from "../../infra/agent-client/connect";
import type { AgentConnection } from "../../infra/agent-client/connection";
import { BACKUP_CAPABILITY } from "../../infra/agent-client/hello-capabilities";
import {
  reconcileInFlightBackupRuns,
  sweepOrphanedBackupArtifacts,
} from "./orphan-sweep";

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

test("reconcileInFlightBackupRuns flips stale running runs + stuck schedules to failed", async () => {
  await seedBackup(db, {
    id: "bkp_1",
    destinationId: "s3_1",
    databaseId: "db_1",
  });
  await db
    .update(backupsTable)
    .set({ lastStatus: "running" })
    .where(eq(backupsTable.id, "bkp_1"));

  await seedRun(db, {
    id: "r_old",
    destinationId: "s3_1",
    databaseId: "db_1",
    backupId: "bkp_1",
    status: "running",
    startedAt: "2020-01-01T00:00:00.000Z",
    finishedAt: null,
  });
  await seedRun(db, {
    id: "r_fresh",
    destinationId: "s3_1",
    databaseId: "db_1",
    backupId: "bkp_1",
    status: "running",
    startedAt: new Date().toISOString(),
    finishedAt: null,
  });

  const n = await reconcileInFlightBackupRuns();
  assert.equal(n, 1, "exactly the orphaned run reconciled");

  const old = (
    await db
      .select()
      .from(backupRunsTable)
      .where(eq(backupRunsTable.id, "r_old"))
  )[0]!;
  assert.equal(old.status, "failed");
  assert.ok(old.finishedAt, "finishedAt stamped");
  const fresh = (
    await db
      .select()
      .from(backupRunsTable)
      .where(eq(backupRunsTable.id, "r_fresh"))
  )[0]!;
  assert.equal(
    fresh.status,
    "running",
    "a genuinely in-flight run is untouched",
  );

  const b = (
    await db.select().from(backupsTable).where(eq(backupsTable.id, "bkp_1"))
  )[0]!;
  assert.equal(b.lastStatus, "failed", "the stuck schedule settled");
});

test("reconcileInFlightBackupRuns is idempotent / a no-op with nothing stale", async () => {
  await seedRun(db, {
    id: "r1",
    destinationId: "s3_1",
    databaseId: "db_1",
    status: "success",
  });
  assert.equal(await reconcileInFlightBackupRuns(), 0);
});

// The FKs are ON DELETE SET NULL, so deleting an app used to blank the only columns naming its artifacts.
test("a deleted App's backups go at the first sweep, with one Activity line", async (t) => {
  const deleted: string[] = [];
  __setAgentConnectorForTest(async () => {
    const conn = {
      hello: async () => ({ capabilities: [BACKUP_CAPABILITY] }),
      s3Delete: async (target: { objectKey: string }) => {
        deleted.push(target.objectKey);
        return { ok: true, error: "", deleted: 1 };
      },
      close: () => {},
    };
    return conn as unknown as AgentConnection;
  });
  t.after(() => __setAgentConnectorForTest());
  await seedRun(db, {
    id: "r_1",
    destinationId: "s3_1",
    appId: "prj_1",
    targetKind: "app",
    objectKey: "k/r_1",
    sizeBytes: 1_678_644_804,
  });
  await pg.exec(`delete from apps where id = 'prj_1';
    update servers set agent_cert_fingerprint = 'fp';`);
  const [row] = await db
    .select()
    .from(backupRunsTable)
    .where(eq(backupRunsTable.id, "r_1"));
  assert.equal(row!.appId, null, "the FK really is blanked by the delete");
  assert.equal(row!.targetId, "prj_1", "target_id survives it");

  assert.equal(await sweepOrphanedBackupArtifacts(), 1);
  assert.deepEqual(deleted, ["k/r_1"]);
  assert.equal((await db.select().from(backupRunsTable)).length, 0);
  const lines = (await db.select().from(activities)).map((a) => a.message);
  assert.deepEqual(lines, [
    "Deleted a backup (1.6 GB) of an App or database no longer in this team",
  ]);
});

// A team transfer blanks app_id too, but the App lives on in the other team: the old team keeps them a while.
test("an App moved to another team leaves its old backups on the keep window", async () => {
  await seedRun(db, {
    id: "r_1",
    destinationId: "s3_1",
    appId: "prj_1",
    targetKind: "app",
    startedAt: "2020-01-01T00:00:00.000Z",
  });
  await db
    .update(backupRunsTable)
    .set({ appId: null })
    .where(eq(backupRunsTable.id, "r_1"));

  const reclaimed = await sweepOrphanedBackupArtifacts();
  assert.equal(reclaimed, 0, "the first sweep only starts the clock");
  const [stamped] = await db
    .select()
    .from(backupRunsTable)
    .where(eq(backupRunsTable.id, "r_1"));
  assert.ok(stamped!.orphanedAt, "orphaned_at is set");

  await sweepOrphanedBackupArtifacts();
  const [again] = await db
    .select()
    .from(backupRunsTable)
    .where(eq(backupRunsTable.id, "r_1"));
  assert.equal(
    again!.orphanedAt,
    stamped!.orphanedAt,
    "the clock is not reset",
  );
});

test("an artifact is only reclaimed once the keep window has elapsed", async () => {
  await seedRun(db, {
    id: "r_old",
    destinationId: "s3_1",
    appId: "prj_1",
    targetKind: "app",
    status: "failed",
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
  assert.equal(
    row!.orphanedAt,
    null,
    "a live app's artifacts are not the sweep's business",
  );
});
