import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../../db/test-harness";
import { __setTestDb, __resetTestDb } from "../../db/client";
import { activities as activitiesTable } from "../../db/schema/control-plane/activity";
import { databases as databasesTable } from "../../db/schema/control-plane/databases";
import { TEAM_B } from "../identity-test-helpers";
import { seedDatabase, settleProvisioning } from "../backup-test-helpers";
import { getConnectionString, getDatabase } from "./rows";
import {
  updateDatabaseResources,
  updateDatabaseImage,
  renameDatabase,
  updateDatabaseLogo,
} from "./settings";
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

test("updateDatabaseResources: validates, persists, and round-trips via the DTO", async () => {
  await seedDatabase(db, { id: "db_lim", name: "lim" });
  await asUser1(async () => {
    await updateDatabaseResources("db_lim", { memoryMb: 512, cpuMilli: 500 });
    const dto = await getDatabase("db_lim");
    assert.equal(dto?.resources?.memoryMb, 512);
    assert.equal(dto?.resources?.cpuMilli, 500);
    assert.equal(dto?.resources?.pidsLimit, null);

    await updateDatabaseResources("db_lim", {});
    assert.equal((await getDatabase("db_lim"))?.resources, null);

    await assert.rejects(
      updateDatabaseResources("db_lim", { swapMb: 1024 }),
      /memory limit before a swap limit/,
    );
  });
});

test("updateDatabaseResources: a cross-team id hits 0 rows (Not found)", async () => {
  await seedDatabase(db, { id: "db_foreign", teamId: TEAM_B, name: "foreign" });
  await asUser1(async () => {
    await assert.rejects(
      updateDatabaseResources("db_foreign", { memoryMb: 256 }),
      /Not found/,
    );
  });
});

test("updateDatabaseImage: set + clear round-trip, syntax rejected", async () => {
  await seedDatabase(db, { id: "db_img", name: "img" });
  await asUser1(async () => {
    await updateDatabaseImage("db_img", {
      customImage: "timescale/timescaledb:2-pg16",
      customCommand: "postgres -c shared_buffers=256MB",
      version: "16.3",
    });
    let dto = await getDatabase("db_img");
    assert.equal(dto?.customImage, "timescale/timescaledb:2-pg16");
    assert.equal(dto?.customCommand, "postgres -c shared_buffers=256MB");
    assert.equal(dto?.version, "16.3");

    await updateDatabaseImage("db_img", { customImage: null });
    dto = await getDatabase("db_img");
    assert.equal(dto?.customImage, null);
    assert.equal(dto?.customCommand, "postgres -c shared_buffers=256MB");

    await assert.rejects(
      updateDatabaseImage("db_img", { customImage: "bad image ref" }),
      /plain image reference/,
    );
    await assert.rejects(
      updateDatabaseImage("db_img", { customCommand: "line1\nline2" }),
      /single line/,
    );
    await assert.rejects(
      updateDatabaseImage("db_img", { version: "not a tag!" }),
      /valid image tag/,
    );
  });
});

test("renameDatabase changes only the display name - host and connection string are untouched", async () => {
  await seedDatabase(db, { id: "db_r", name: "main" });
  await asUser1(async () => {
    const before = await getDatabase("db_r");
    await renameDatabase("db_r", "  Primary Store  ");
    const after = await getDatabase("db_r");
    assert.equal(after?.name, "Primary Store");
    assert.equal(after?.host, before?.host, "host slug frozen");
    assert.equal(
      after?.connectionStringMasked,
      before?.connectionStringMasked,
      "connection string unaffected",
    );
    assert.equal(
      await getConnectionString("db_r"),
      await getConnectionString("db_r"),
    );
  });
  const logged = await db.select().from(activitiesTable);
  assert.ok(
    logged.some((a) => a.message === "Renamed database main to Primary Store"),
    `rename is recorded, got: ${logged.map((a) => a.message).join(" | ")}`,
  );
});

test("renameDatabase: validates, refuses a duplicate, no-ops on an unchanged name", async () => {
  await seedDatabase(db, { id: "db_n1", name: "alpha" });
  await seedDatabase(db, { id: "db_n2", name: "beta" });
  await asUser1(async () => {
    await assert.rejects(renameDatabase("db_n1", "   "), /name is required/i);
    await assert.rejects(
      renameDatabase("db_n1", "x".repeat(61)),
      /60 characters/,
    );
    await assert.rejects(
      renameDatabase("db_n1", "beta"),
      /already exists in this team/,
    );

    const activityBefore = (await db.select().from(activitiesTable)).length;
    await renameDatabase("db_n1", "alpha");
    assert.equal(
      (await db.select().from(activitiesTable)).length,
      activityBefore,
    );
  });
});

test("renameDatabase: a cross-team id is Not found", async () => {
  await seedDatabase(db, { id: "db_other", teamId: TEAM_B, name: "theirs" });
  await asUser1(async () => {
    await assert.rejects(renameDatabase("db_other", "mine"), /Not found/);
  });
  const rows = await db
    .select()
    .from(databasesTable)
    .where(eq(databasesTable.id, "db_other"));
  assert.equal(rows[0]!.name, "theirs");
});

test("updateDatabaseLogo: set, clear, validate, and stay team-scoped", async () => {
  const png =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  await seedDatabase(db, { id: "db_l", name: "logo" });
  await asUser1(async () => {
    assert.equal((await getDatabase("db_l"))?.logo, null);

    await updateDatabaseLogo("db_l", png);
    assert.equal((await getDatabase("db_l"))?.logo, png);

    await assert.rejects(
      updateDatabaseLogo("db_l", "https://example.com/evil.svg"),
      /Unsupported logo image/,
    );
    assert.equal(
      (await getDatabase("db_l"))?.logo,
      png,
      "rejected value not stored",
    );

    await updateDatabaseLogo("db_l", null);
    assert.equal((await getDatabase("db_l"))?.logo, null);
  });

  await seedDatabase(db, { id: "db_lf", teamId: TEAM_B, name: "foreign-logo" });
  await asUser1(async () => {
    await assert.rejects(updateDatabaseLogo("db_lf", png), /Not found/);
  });
});
