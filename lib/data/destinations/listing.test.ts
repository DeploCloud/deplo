import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../../db/test-harness";
import { __setTestDb, __resetTestDb } from "../../db/client";
import { backupDestination as destTable } from "../../db/schema/control-plane/backups";
import { TEAM_B } from "../identity-test-helpers";
import { SERVER_1 } from "../app-graph-test-helpers";
import { seedDatabase, seedDestination, seedRun } from "../backup-test-helpers";
import { toDestinationOption } from "./dto";
import { listDestinations, listDestinationOptions } from "./listing";
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

test("listDestinations is team-scoped and newest-first", async () => {
  await seedDestination(db, { id: "s3_a", name: "a" });
  await db
    .update(destTable)
    .set({ createdAt: "2026-02-01T00:00:00.000Z" })
    .where(eq(destTable.id, "s3_a"));
  await seedDestination(db, { id: "s3_b", name: "b" });
  await db
    .update(destTable)
    .set({ createdAt: "2026-03-01T00:00:00.000Z" })
    .where(eq(destTable.id, "s3_b"));
  await seedDestination(db, { id: "s3_other", teamId: TEAM_B, name: "other" });

  await asUser1(async () => {
    const list = await listDestinations();
    assert.deepEqual(
      list.map((s) => s.id),
      ["s3_b", "s3_a"],
    );
  });
});

test("toDestinationOption keeps only what a picker needs, for both kinds", async () => {
  await seedDestination(db, { id: "s3_1", name: "Backups" });
  await asUser1(async () => {
    const [dto] = await listDestinations();
    assert.deepEqual(toDestinationOption(dto!), {
      id: "s3_1",
      name: "Backups",
      kind: "s3",
      where: "https://s3.us-east-1.amazonaws.com",
      status: "connected",
      serverId: null,
      encrypted: true,
      recoveryKeySavedAt: null,
    });
  });
});

test("toDestinationOption describes a server destination by server and folder", async () => {
  await seedDestination(db, {
    id: "dst_srv",
    name: "Nightly",
    kind: "server",
    serverId: SERVER_1,
  });
  await db
    .update(destTable)
    .set({ resolvedPath: "/data/backups" })
    .where(eq(destTable.id, "dst_srv"));
  await asUser1(async () => {
    const dto = (await listDestinations()).find((d) => d.id === "dst_srv")!;
    const opt = toDestinationOption(dto);
    assert.equal(opt.kind, "server");
    assert.equal(opt.serverId, SERVER_1);
    assert.match(opt.where, /\/data\/backups$/);
    assert.ok(!opt.where.startsWith("·"), "the server name comes first");
  });
});

test("a server destination never leaks its private key into a DTO", async () => {
  await seedDestination(db, {
    id: "dst_key",
    kind: "server",
    serverId: SERVER_1,
  });
  await asUser1(async () => {
    const dto = (await listDestinations()).find((d) => d.id === "dst_key")!;
    assert.ok(dto.ageRecipient?.startsWith("age1"));
    assert.equal("ageIdentityEnc" in dto, false);
    assert.equal(JSON.stringify(dto).includes("AGE-SECRET-KEY"), false);
  });
});

test("listDestinationOptions carries no credential and no test history", async () => {
  await seedDestination(db, { id: "dst_s3", kind: "s3" });
  await asUser1(async () => {
    const opts = await listDestinationOptions();
    const one = opts.find((d) => d.id === "dst_s3")!;
    assert.deepEqual(Object.keys(one).sort(), [
      "encrypted",
      "id",
      "kind",
      "name",
      "recoveryKeySavedAt",
      "serverId",
      "status",
      "where",
    ]);
    const json = JSON.stringify(opts);
    assert.equal(json.includes("AKIA"), false);
    assert.equal(json.includes("AGE-SECRET-KEY"), false);
    assert.equal(json.includes("lastTest"), false);
  });
});

test("listDestinationOptions is team-scoped", async () => {
  await seedDestination(db, { id: "dst_mine", kind: "s3" });
  await seedDestination(db, { id: "dst_theirs", kind: "s3", teamId: TEAM_B });
  await asUser1(async () => {
    const ids = (await listDestinationOptions()).map((d) => d.id);
    assert.ok(ids.includes("dst_mine"));
    assert.equal(ids.includes("dst_theirs"), false);
  });
});

test("listDestinations reports what each destination actually holds", async () => {
  await seedDestination(db, { id: "dst_1", kind: "s3" });
  await seedDestination(db, { id: "dst_2", kind: "s3", name: "Other" });
  await seedDatabase(db, { id: "db_1", name: "main" });
  await seedRun(db, {
    id: "r_1",
    destinationId: "dst_1",
    databaseId: "db_1",
    sizeBytes: 1024,
  });
  await seedRun(db, {
    id: "r_2",
    destinationId: "dst_1",
    databaseId: "db_1",
    sizeBytes: 2048,
  });
  await seedRun(db, {
    id: "r_3",
    destinationId: "dst_1",
    databaseId: "db_1",
    sizeBytes: 9999,
    status: "failed",
  });
  await seedRun(db, {
    id: "r_4",
    destinationId: "dst_2",
    databaseId: "db_1",
    sizeBytes: 4096,
  });

  await asUser1(async () => {
    const byId = new Map((await listDestinations()).map((d) => [d.id, d]));
    assert.equal(byId.get("dst_1")!.storedBytes, 3072);
    assert.equal(byId.get("dst_1")!.storedCount, 2);
    assert.equal(byId.get("dst_2")!.storedBytes, 4096);
    assert.equal(byId.get("dst_2")!.storedCount, 1);
  });
});

test("a destination that has never been written to holds nothing, not null", async () => {
  await seedDestination(db, { id: "dst_1", kind: "s3" });
  await asUser1(async () => {
    const [d] = await listDestinations();
    assert.equal(d.storedBytes, 0);
    assert.equal(d.storedCount, 0);
  });
});
