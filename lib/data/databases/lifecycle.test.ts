import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../../db/test-harness";
import { __setTestDb, __resetTestDb } from "../../db/client";
import { activities as activitiesTable } from "../../db/schema/control-plane/activity";
import {
  backups as backupsTable,
  backupRuns as backupRunsTable,
} from "../../db/schema/control-plane/backups";
import { databases as databasesTable } from "../../db/schema/control-plane/databases";
import { pendingTeardowns as pendingTeardownsTable } from "../../db/schema/control-plane/deployments";
import {
  seedBackup,
  seedDatabase,
  seedRun,
  seedS3,
  settleProvisioning,
} from "../backup-test-helpers";
import {
  deleteDatabase,
  restartDatabase,
  redeployDatabase,
  rebuildDatabase,
} from "./lifecycle";
import { getDatabase } from "./rows";
import { asUser1, seedBase } from "./databases-test-helpers";

let db: TestDb;
let pg: PGlite;

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
});

after(async () => {
  await settleProvisioning(db);
  __resetTestDb();
  await pg.close();
});

beforeEach(async () => {
  await settleProvisioning(db);
  await seedBase(db, pg);
});

test("deleteDatabase refuses (deleting nothing) when the server can't be torn down", async () => {
  await seedDatabase(db, { id: "db_1", name: "main" });
  const s3 = await seedS3(db, { id: "s3_1" });
  await seedBackup(db, { id: "bkp_1", destinationId: s3, databaseId: "db_1" });

  await asUser1(() =>
    assert.rejects(
      () => deleteDatabase("db_1"),
      /main was NOT deleted[\s\S]*delete it\s+anyway/i,
    ),
  );

  assert.equal(
    (
      await db
        .select()
        .from(databasesTable)
        .where(eq(databasesTable.id, "db_1"))
    ).length,
    1,
    "the database row survives a refused delete",
  );
  assert.equal(
    (await db.select().from(backupsTable).where(eq(backupsTable.id, "bkp_1")))
      .length,
    1,
    "its backup schedule survives too (nothing cascaded)",
  );
});

test("deleteDatabase cascades schedules and SET NULLs run history (no orphans)", async () => {
  await seedDatabase(db, { id: "db_1", name: "main" });
  const s3 = await seedS3(db, { id: "s3_1" });
  await seedBackup(db, { id: "bkp_1", destinationId: s3, databaseId: "db_1" });
  await seedRun(db, {
    id: "brun_1",
    destinationId: s3,
    databaseId: "db_1",
    backupId: "bkp_1",
  });

  await asUser1(() => deleteDatabase("db_1", { force: true }));

  assert.equal(
    (
      await db
        .select()
        .from(databasesTable)
        .where(eq(databasesTable.id, "db_1"))
    ).length,
    0,
    "database row deleted",
  );
  assert.equal(
    (await db.select().from(backupsTable).where(eq(backupsTable.id, "bkp_1")))
      .length,
    0,
    "dependent schedule CASCADE-deleted",
  );
  const run = await db
    .select()
    .from(backupRunsTable)
    .where(eq(backupRunsTable.id, "brun_1"));
  assert.equal(run.length, 1, "run history survives");
  assert.equal(run[0]!.databaseId, null, "run.databaseId SET NULL");

  const queuedRows = await db.select().from(pendingTeardownsTable);
  assert.deepEqual(
    queuedRows.map((r) => [r.deployKey, r.projectLabel]),
    [["db-main", "db_1"]],
    "the forced delete queued the leftover stack",
  );
  const logged = await db.select().from(activitiesTable);
  assert.ok(
    logged.some(
      (a) =>
        a.message.includes("main") &&
        a.message.includes("will retry the teardown"),
    ),
    `forced delete records the leftovers, got: ${logged.map((a) => a.message).join(" | ")}`,
  );
});

test("restart/redeploy/rebuild: gated while provisioning with the curated message", async () => {
  await seedDatabase(db, {
    id: "db_prov",
    name: "prov",
    status: "provisioning",
  });
  await asUser1(async () => {
    await assert.rejects(restartDatabase("db_prov"), /still provisioning/);
    await assert.rejects(redeployDatabase("db_prov"), /still provisioning/);
    await assert.rejects(rebuildDatabase("db_prov"), /still provisioning/);
  });
});

test("rebuildDatabase: unreachable agent fails clearly and leaves the row intact", async () => {
  await seedDatabase(db, { id: "db_rb", name: "rb" });
  await asUser1(async () => {
    await assert.rejects(rebuildDatabase("db_rb"));
    const dto = await getDatabase("db_rb");
    assert.ok(dto, "row survives the failed rebuild");
    assert.equal(
      dto.status,
      "running",
      "status untouched - nothing was torn down",
    );
  });
});

test("rebuild/redeploy refuse to render an undecryptable password (no empty-auth engine)", async () => {
  await seedDatabase(db, { id: "db_undec", name: "undec" });
  await db
    .update(databasesTable)
    .set({
      connectionStringEnc: "v1.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA.AAAA",
    })
    .where(eq(databasesTable.id, "db_undec"));
  await asUser1(async () => {
    await assert.rejects(rebuildDatabase("db_undec"), /could not be decrypted/);
    await assert.rejects(
      redeployDatabase("db_undec"),
      /could not be decrypted/,
    );
    assert.equal((await getDatabase("db_undec"))!.status, "running");
  });
});
