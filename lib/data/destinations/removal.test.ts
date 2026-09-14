import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../../db/test-harness";
import { __setTestDb, __resetTestDb } from "../../db/client";
import {
  backups as backupsTable,
  backupRuns as backupRunsTable,
  backupDestination as destTable,
} from "../../db/schema/control-plane/backups";
import { TEAM_B } from "../identity-test-helpers";
import {
  seedBackup,
  seedDatabase,
  seedDestination,
  seedRun,
} from "../backup-test-helpers";
import { deleteDestination, destinationRemovalImpact } from "./removal";
import {
  TRUNCATE,
  asUser1,
  seedDestinationFixtures,
} from "./destinations-test-helpers";

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
  await pg.exec(TRUNCATE);
  await seedDestinationFixtures(db);
});

test("deleteDestination removes dependent schedules AND run history in one transaction", async () => {
  await seedDatabase(db, { id: "db_1" });
  await seedDestination(db, { id: "s3_1" });
  await seedBackup(db, {
    id: "bkp_1",
    destinationId: "s3_1",
    databaseId: "db_1",
  });
  await seedRun(db, {
    id: "brun_1",
    destinationId: "s3_1",
    databaseId: "db_1",
    backupId: "bkp_1",
  });

  await asUser1(() => deleteDestination("s3_1"));

  assert.equal(
    (await db.select().from(destTable).where(eq(destTable.id, "s3_1"))).length,
    0,
  );
  assert.equal(
    (
      await db
        .select()
        .from(backupsTable)
        .where(eq(backupsTable.destinationId, "s3_1"))
    ).length,
    0,
    "dependent schedule removed (RESTRICT FK ⇒ explicit delete)",
  );
  assert.equal(
    (
      await db
        .select()
        .from(backupRunsTable)
        .where(eq(backupRunsTable.destinationId, "s3_1"))
    ).length,
    0,
    "dependent run history removed (no dangling destinationId)",
  );
});

test("deleteDestination is team-scoped (a foreign destination is not found)", async () => {
  await seedDestination(db, { id: "s3_b", teamId: TEAM_B });
  await asUser1(async () => {
    await assert.rejects(() => deleteDestination("s3_b"), /Not found/);
  });
  assert.equal(
    (await db.select().from(destTable).where(eq(destTable.id, "s3_b"))).length,
    1,
  );
});

test("destinationRemovalImpact counts what the confirm dialog has to name", async () => {
  await seedDestination(db, { id: "dst_1", kind: "s3" });
  await seedDatabase(db, { id: "db_1", name: "main" });
  await seedBackup(db, {
    id: "bkp_1",
    destinationId: "dst_1",
    databaseId: "db_1",
  });
  await seedRun(db, { id: "r_ok", destinationId: "dst_1", databaseId: "db_1" });
  await seedRun(db, {
    id: "r_bad",
    destinationId: "dst_1",
    databaseId: "db_1",
    status: "failed",
  });
  await asUser1(async () => {
    const impact = await destinationRemovalImpact("dst_1");
    assert.equal(impact.schedules, 1);
    assert.equal(impact.runs, 2, "history, whatever its outcome");
    assert.equal(impact.artifacts, 1, "only a successful run wrote a file");
  });
});

test("deleteDestination can take the backup files with it, or leave them", async () => {
  await seedDestination(db, { id: "dst_keep", kind: "s3" });
  await seedDatabase(db, { id: "db_2", name: "two" });
  await seedRun(db, {
    id: "r_keep",
    destinationId: "dst_keep",
    databaseId: "db_2",
  });
  await asUser1(async () => {
    await deleteDestination("dst_keep");
  });
  const left = await db.select().from(backupRunsTable);
  assert.equal(
    left.filter((r) => r.id === "r_keep").length,
    0,
    "the records always go with the destination",
  );

  await seedDestination(db, { id: "dst_sweep", kind: "s3" });
  await seedRun(db, {
    id: "r_sweep",
    destinationId: "dst_sweep",
    databaseId: "db_2",
  });
  await asUser1(async () => {
    await assert.rejects(() =>
      deleteDestination("dst_sweep", { deleteArtifacts: true }),
    );
  });
  const survivors = await db.select().from(backupRunsTable);
  assert.equal(
    survivors.filter((r) => r.id === "r_sweep").length,
    1,
    "nothing is dropped while its file is still out there",
  );
});
