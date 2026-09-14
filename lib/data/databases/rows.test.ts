import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../../db/test-harness";
import { __setTestDb, __resetTestDb } from "../../db/client";
import { databases as databasesTable } from "../../db/schema/control-plane/databases";
import { runWithIdentity } from "../../auth/request-context";
import { seedIdentity, TEAM_A, TEAM_B, USER_1 } from "../identity-test-helpers";
import { seedDatabase, settleProvisioning } from "../backup-test-helpers";
import {
  getConnectionString,
  getDatabase,
  listDatabases,
  reorderDatabases,
} from "./rows";
import { TRUNCATE, asUser1, seedBase } from "./databases-test-helpers";

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

test("listDatabases is team-scoped, newest-first, and masks the connection string", async () => {
  await seedDatabase(db, { id: "db_old", name: "old" });
  await db
    .update(databasesTable)
    .set({ createdAt: "2026-02-01T00:00:00.000Z" })
    .where(eq(databasesTable.id, "db_old"));
  await seedDatabase(db, { id: "db_new", name: "new" });
  await db
    .update(databasesTable)
    .set({ createdAt: "2026-03-01T00:00:00.000Z" })
    .where(eq(databasesTable.id, "db_new"));
  await seedDatabase(db, { id: "db_other", teamId: TEAM_B, name: "other" });

  await asUser1(async () => {
    const list = await listDatabases();
    assert.deepEqual(
      list.map((d) => d.id),
      ["db_new", "db_old"],
    );
    assert.equal(
      "connectionStringEnc" in list[0]!,
      false,
      "no secret in the DTO",
    );
    assert.ok(
      list[0]!.connectionStringMasked.includes("••••"),
      "password masked",
    );
  });
});

test("getConnectionString decrypts; getDatabase is team-scoped", async () => {
  await seedDatabase(db, { id: "db_1", name: "main" });
  await asUser1(async () => {
    const conn = await getConnectionString("db_1");
    assert.ok(conn.startsWith("postgres://"), "decrypted plaintext");
    assert.ok((await getDatabase("db_1")) !== null);
  });
  await runWithIdentity({ userId: "user_2", teamId: TEAM_B }, async () => {
    assert.equal(await getDatabase("db_1"), null);
    await assert.rejects(() => getConnectionString("db_1"), /Not found/);
  });
});

test("reorderDatabases persists a team order that listDatabases honours", async () => {
  await seedDatabase(db, { id: "db_a", name: "aaa" });
  await db
    .update(databasesTable)
    .set({ createdAt: "2026-01-01T00:00:00.000Z" })
    .where(eq(databasesTable.id, "db_a"));
  await seedDatabase(db, { id: "db_b", name: "bbb" });
  await db
    .update(databasesTable)
    .set({ createdAt: "2026-02-01T00:00:00.000Z" })
    .where(eq(databasesTable.id, "db_b"));
  await seedDatabase(db, { id: "db_c", name: "ccc" });
  await db
    .update(databasesTable)
    .set({ createdAt: "2026-03-01T00:00:00.000Z" })
    .where(eq(databasesTable.id, "db_c"));

  await asUser1(async () => {
    assert.deepEqual(
      (await listDatabases()).map((d) => d.id),
      ["db_c", "db_b", "db_a"],
    );

    await reorderDatabases(["db_a", "db_c", "db_b"]);
    assert.deepEqual(
      (await listDatabases()).map((d) => d.id),
      ["db_a", "db_c", "db_b"],
    );

    await reorderDatabases(["db_b"]);
    assert.deepEqual(
      (await listDatabases()).map((d) => d.id),
      ["db_b", "db_c", "db_a"],
    );

    await reorderDatabases(["db_nope", "db_a"]);
    assert.deepEqual(
      (await listDatabases()).map((d) => d.id),
      ["db_a", "db_c", "db_b"],
    );
  });
});

test("reorderDatabases self-heals on delete (FK cascade) and rejects without manage_infra", async () => {
  await seedDatabase(db, { id: "db_x", name: "xxx" });
  await seedDatabase(db, { id: "db_y", name: "yyy" });
  await asUser1(async () => {
    await reorderDatabases(["db_y", "db_x"]);
    await db.delete(databasesTable).where(eq(databasesTable.id, "db_y"));
    assert.deepEqual(
      (await listDatabases()).map((d) => d.id),
      ["db_x"],
    );
  });

  await pg.exec(TRUNCATE);
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      {
        id: "user_viewer2",
        teamId: TEAM_A,
        role: "member",
        capabilities: ["view"],
      },
    ],
  });
  await seedDatabase(db, { id: "db_z", name: "zzz" });
  await runWithIdentity(
    { userId: "user_viewer2", teamId: TEAM_A },
    async () => {
      await assert.rejects(reorderDatabases(["db_z"]));
    },
  );
});
