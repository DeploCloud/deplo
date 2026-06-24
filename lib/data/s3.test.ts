import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import {
  backups as backupsTable,
  backupRuns as backupRunsTable,
  s3Destination as s3Table,
} from "../db/schema/control-plane";
import { runWithIdentity } from "../auth/request-context";
import { decryptSecret } from "../crypto";
import { seedIdentity, TEAM_A, TEAM_B, USER_1 } from "./identity-test-helpers";
import { seedServer } from "./project-graph-test-helpers";
import {
  seedBackup,
  seedDatabase,
  seedRun,
  seedS3,
  TRUNCATE_BACKUPS,
} from "./backup-test-helpers";
import { createS3, deleteS3, getS3WithSecrets, listS3 } from "./s3";

/**
 * Data-layer tests for `s3` against pglite (PLAN Step 5, cut-set (d)). Verifies the
 * newest-first SQL list, the masked DTO + decrypted creds for the executor, team
 * isolation, and that `deleteS3` removes dependent backup schedules AND run history
 * in ONE transaction (the `destination_id` FK is RESTRICT, so the dependents are
 * deleted explicitly — never cascade-orphaned).
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

test("createS3 stores encrypted creds; the DTO masks them and starts unverified", async () => {
  await asUser1(async () => {
    const dto = await createS3({
      name: "Backblaze",
      provider: "backblaze-b2",
      endpoint: "https://s3.eu.backblazeb2.com",
      region: "eu",
      bucket: "deplo",
      accessKey: "AKIA",
      secretKey: "s3cret",
    });
    assert.equal(dto.status, "unverified");
    assert.equal(dto.accessKeyMasked, "••••••••");
    assert.equal("accessKeyEnc" in dto, false);
    assert.equal("secretKeyEnc" in dto, false);
  });
  // The stored row holds ciphertext, decryptable by the executor seam.
  await asUser1(async () => {
    const list = await listS3();
    const creds = await getS3WithSecrets(list[0]!.id);
    assert.equal(creds.accessKey, "AKIA");
    assert.equal(creds.secretKey, "s3cret");
  });
  // The raw row never holds the plaintext.
  const rows = await db.select().from(s3Table);
  assert.notEqual(decryptSecret(rows[0]!.accessKeyEnc), "");
  assert.notEqual(rows[0]!.accessKeyEnc, "AKIA");
});

test("listS3 is team-scoped and newest-first", async () => {
  await seedS3(db, { id: "s3_a", name: "a" });
  await db
    .update(s3Table)
    .set({ createdAt: "2026-02-01T00:00:00.000Z" })
    .where(eq(s3Table.id, "s3_a"));
  await seedS3(db, { id: "s3_b", name: "b" });
  await db
    .update(s3Table)
    .set({ createdAt: "2026-03-01T00:00:00.000Z" })
    .where(eq(s3Table.id, "s3_b"));
  await seedS3(db, { id: "s3_other", teamId: TEAM_B, name: "other" });

  await asUser1(async () => {
    const list = await listS3();
    assert.deepEqual(list.map((s) => s.id), ["s3_b", "s3_a"]);
  });
});

test("deleteS3 removes dependent schedules AND run history in one transaction", async () => {
  await seedDatabase(db, { id: "db_1" });
  await seedS3(db, { id: "s3_1" });
  await seedBackup(db, { id: "bkp_1", destinationId: "s3_1", databaseId: "db_1" });
  await seedRun(db, { id: "brun_1", destinationId: "s3_1", databaseId: "db_1", backupId: "bkp_1" });

  await asUser1(() => deleteS3("s3_1"));

  assert.equal((await db.select().from(s3Table).where(eq(s3Table.id, "s3_1"))).length, 0);
  assert.equal(
    (await db.select().from(backupsTable).where(eq(backupsTable.destinationId, "s3_1"))).length,
    0,
    "dependent schedule removed (RESTRICT FK ⇒ explicit delete)",
  );
  assert.equal(
    (await db.select().from(backupRunsTable).where(eq(backupRunsTable.destinationId, "s3_1"))).length,
    0,
    "dependent run history removed (no dangling destinationId)",
  );
});

test("deleteS3 is team-scoped (a foreign destination is not found)", async () => {
  await seedS3(db, { id: "s3_b", teamId: TEAM_B });
  await asUser1(async () => {
    await assert.rejects(() => deleteS3("s3_b"), /Not found/);
  });
  // Still present.
  assert.equal((await db.select().from(s3Table).where(eq(s3Table.id, "s3_b"))).length, 1);
});
