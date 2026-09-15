import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../../db/test-harness";
import { __setTestDb, __resetTestDb } from "../../db/client";
import { teams as teamsTable } from "../../db/schema/control-plane/identity";
import { servers as serversTable } from "../../db/schema/control-plane/servers";
import { TEAM_A } from "../identity-test-helpers";
import { seedServerRow } from "../infra-test-helpers";
import { seedDestination } from "../backup-test-helpers";
import { ensureDefaultDestination } from "./create";
import { listDestinations } from "./listing";
import { deleteDestination } from "./removal";
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

async function seedBackupCapableServer(): Promise<void> {
  await seedServerRow(db, {
    id: "srv_store",
    name: "store-1",
    ip: "10.0.0.9",
    host: "10.0.0.9",
    agent: {
      port: 9443,
      certFingerprint: "sha256:pinned",
      certPem: "-----BEGIN CERTIFICATE-----",
      version: "1.20.0",
    },
  });
}

const seededFlag = async (): Promise<string | null> =>
  (await db.select().from(teamsTable).where(eq(teamsTable.id, TEAM_A)))[0]
    ?.backupDefaultSeededAt ?? null;

test("the default destination is created once, on a server the team can reach", async () => {
  await seedBackupCapableServer();
  await asUser1(async () => {
    await ensureDefaultDestination();
    await ensureDefaultDestination();
    const list = await listDestinations();
    assert.equal(list.length, 1);
    assert.equal(list[0]!.kind, "server");
    assert.equal(list[0]!.serverId, "srv_store");
    assert.ok(list[0]!.ageRecipient?.startsWith("age1"));
  });
  assert.ok(await seededFlag());
});

test("removing the default destination keeps it removed", async () => {
  await seedBackupCapableServer();
  await asUser1(async () => {
    await ensureDefaultDestination();
    const [seeded] = await listDestinations();
    await deleteDestination(seeded!.id);
    await ensureDefaultDestination();
    assert.deepEqual(await listDestinations(), []);
  });
});

test("two renders at once seed one destination, not two", async () => {
  await seedBackupCapableServer();
  await asUser1(async () => {
    await Promise.all([ensureDefaultDestination(), ensureDefaultDestination()]);
    assert.equal((await listDestinations()).length, 1);
  });
});

test("a team that already has a destination is never given another", async () => {
  await seedBackupCapableServer();
  await seedDestination(db, { id: "s3_mine", name: "mine" });
  await asUser1(async () => {
    await ensureDefaultDestination();
    assert.deepEqual(
      (await listDestinations()).map((d) => d.id),
      ["s3_mine"],
    );
  });
  assert.ok(await seededFlag());
});

test("no backup-capable server yet: nothing is seeded, and the seed can still happen later", async () => {
  await db.delete(serversTable).where(eq(serversTable.id, "srv_store"));
  await asUser1(async () => {
    await ensureDefaultDestination();
    assert.deepEqual(await listDestinations(), []);
  });
  assert.equal(await seededFlag(), null);

  await seedBackupCapableServer();
  await asUser1(async () => {
    await ensureDefaultDestination();
    assert.equal((await listDestinations()).length, 1);
  });
});
