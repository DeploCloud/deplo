import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../../db/test-harness";
import { __setTestDb, __resetTestDb } from "../../db/client";
import { backupRuns as backupRunsTable } from "../../db/schema/control-plane/backups";
import { runWithIdentity } from "../../auth/request-context";
import {
  seedIdentity,
  TEAM_A,
  TRUNCATE_IDENTITY,
  USER_1,
} from "../identity-test-helpers";
import { seedServer } from "../app-graph-test-helpers";
import { seedDatabase, seedRun, seedS3 } from "../backup-test-helpers";
import { asUser1, seedBase, USER_SCHEDULER } from "./backups-test-helpers";
import {
  backupDestinationsForTarget,
  countBackupArtifacts,
  deleteAllBackupArtifacts,
  deleteBackupRun,
} from "./artifact-delete";
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

test("backupDestinationsForTarget returns the distinct buckets a target ran to", async () => {
  await seedS3(db, { id: "s3_2", name: "second" });
  await seedRun(db, { id: "r1", destinationId: "s3_1", databaseId: "db_1" });
  await seedRun(db, { id: "r2", destinationId: "s3_1", databaseId: "db_1" });
  await seedRun(db, { id: "r3", destinationId: "s3_2", databaseId: "db_1" });
  await asUser1(async () => {
    const dests = await backupDestinationsForTarget({
      kind: "database",
      targetId: "db_1",
    });
    assert.deepEqual([...dests].sort(), ["s3_1", "s3_2"]);
  });
});

test("countBackupArtifacts counts only SUCCESSFUL runs of the given target", async () => {
  await seedRun(db, {
    id: "r_ok1",
    destinationId: "s3_1",
    databaseId: "db_1",
    status: "success",
  });
  await seedRun(db, {
    id: "r_ok2",
    destinationId: "s3_1",
    databaseId: "db_1",
    status: "success",
  });
  await seedRun(db, {
    id: "r_fail",
    destinationId: "s3_1",
    databaseId: "db_1",
    status: "failed",
  });
  await seedRun(db, {
    id: "r_run",
    destinationId: "s3_1",
    databaseId: "db_1",
    status: "running",
  });
  await seedRun(db, {
    id: "r_app",
    destinationId: "s3_1",
    appId: "prj_1",
    targetKind: "app",
    status: "success",
  });
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
  await seedRun(db, {
    id: "r_fail",
    destinationId: "s3_1",
    databaseId: "db_1",
    status: "failed",
  });
  await asUser1(async () => {
    assert.equal(
      await countBackupArtifacts({ kind: "database", targetId: "db_1" }),
      0,
    );
    assert.equal(
      await countBackupArtifacts({ kind: "app", targetId: "prj_1" }),
      0,
    );
  });
});

test("deleteAllBackupArtifacts (database) needs delete_databases, not manage_backups", async () => {
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
  const rows = await db
    .select()
    .from(backupRunsTable)
    .where(eq(backupRunsTable.id, "r_1"));
  assert.equal(rows.length, 1);
});

test("a failed run leaves no file, so its record goes on its own", async () => {
  await asUser1(async () => {
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
  await runWithIdentity(
    { userId: USER_SCHEDULER, teamId: TEAM_A },
    async () => {
      await assert.rejects(
        () => deleteBackupRun("brun_guarded"),
        /permission/i,
      );
    },
  );
  await asUser1(async () => {
    assert.equal((await listBackupRuns({ appId: "prj_1" })).length, 1);
  });
});
