import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../../db/test-harness";
import { __setTestDb, __resetTestDb } from "../../db/client";
import { backupDestination as destTable } from "../../db/schema/control-plane/backups";
import { SERVER_1 } from "../app-graph-test-helpers";
import { seedDestination } from "../backup-test-helpers";
import { createDestination } from "./create";
import { revealRecoveryKey } from "./recovery-key";
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

test("an encrypted BUCKET has a recovery key, and an older one honestly has none", async () => {
  await asUser1(async () => {
    const bucket = await createDestination({
      name: "encrypted bucket",
      kind: "s3",
      provider: "aws",
      endpoint: "https://s3.us-east-1.amazonaws.com",
      region: "us-east-1",
      bucket: "deplo-backups",
      accessKey: "AKIA_TEST",
      secretKey: "secret_test",
    });
    const key = await revealRecoveryKey(bucket.id);
    assert.ok(
      key.identity.startsWith("AGE-SECRET-KEY"),
      "the private half comes back",
    );
    assert.equal(key.recipient, bucket.ageRecipient);
    assert.match(key.where, /deplo-backups/);
    assert.match(key.where, /s3\.us-east-1\.amazonaws\.com/);
  });

  await seedDestination(db, {
    id: "dst_old",
    kind: "s3",
    legacyPlaintext: true,
  });
  await asUser1(async () => {
    await assert.rejects(
      () => revealRecoveryKey("dst_old"),
      /not encrypted/i,
      "a plaintext destination says so rather than pretending to have a key",
    );
  });
});

test("a server destination's key file says which host and which folder", async () => {
  await seedDestination(db, {
    id: "dst_where",
    kind: "server",
    serverId: SERVER_1,
  });
  await asUser1(async () => {
    const fresh = await revealRecoveryKey("dst_where");
    assert.match(fresh.where, /managed backups folder/);
  });
  await db
    .update(destTable)
    .set({ resolvedPath: "/data/backups" })
    .where(eq(destTable.id, "dst_where"));
  await asUser1(async () => {
    const probed = await revealRecoveryKey("dst_where");
    assert.match(probed.where, /\/data\/backups/);
  });
});
