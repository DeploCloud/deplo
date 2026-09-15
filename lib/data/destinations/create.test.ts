import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";

import { makeTestDb, type TestDb } from "../../db/test-harness";
import { __setTestDb, __resetTestDb } from "../../db/client";
import { backupDestination as destTable } from "../../db/schema/control-plane/backups";
import { decryptSecret } from "../../crypto";
import { seedDestination } from "../backup-test-helpers";
import { createDestination } from "./create";
import { getDestinationWithSecrets } from "./credentials";
import { listDestinations } from "./listing";
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

test("createDestination stores encrypted creds; the DTO masks them and starts unverified", async () => {
  await asUser1(async () => {
    const dto = await createDestination({
      kind: "s3",
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
  await asUser1(async () => {
    const list = await listDestinations();
    const creds = await getDestinationWithSecrets(list[0]!.id);
    assert.equal(creds.accessKey, "AKIA");
    assert.equal(creds.secretKey, "s3cret");
  });
  const rows = await db.select().from(destTable);
  assert.notEqual(decryptSecret(rows[0]!.accessKeyEnc ?? ""), "");
  assert.notEqual(rows[0]!.accessKeyEnc, "AKIA");
});

test("a new S3 destination gets its own keypair, and never leaks the private half", async () => {
  await asUser1(async () => {
    const created = await createDestination({
      name: "bucket",
      kind: "s3",
      provider: "aws",
      endpoint: "https://s3.us-east-1.amazonaws.com",
      region: "us-east-1",
      bucket: "deplo-backups",
      accessKey: "AKIA_TEST",
      secretKey: "secret_test",
    });
    assert.ok(
      created.ageRecipient?.startsWith("age1"),
      "a bucket is encrypted now",
    );
    assert.equal("ageIdentityEnc" in created, false);
    assert.equal(JSON.stringify(created).includes("AGE-SECRET-KEY"), false);
  });
});

test("an S3 destination created before encryption keeps writing plaintext", async () => {
  await seedDestination(db, {
    id: "dst_old",
    kind: "s3",
    legacyPlaintext: true,
  });
  await asUser1(async () => {
    const dto = (await listDestinations()).find((d) => d.id === "dst_old")!;
    assert.equal(dto.ageRecipient, null);
  });
});

test("a bucket name or region carrying shell syntax is refused at creation", async () => {
  await asUser1(async () => {
    await assert.rejects(
      () =>
        createDestination({
          name: "x",
          kind: "s3",
          provider: "aws",
          endpoint: "https://s3.us-east-1.amazonaws.com",
          region: "us-east-1",
          bucket: "b'; rm -rf /; echo '",
          accessKey: "a",
          secretKey: "s",
        }),
      /bucket names/i,
    );
    await assert.rejects(
      () =>
        createDestination({
          name: "x",
          kind: "s3",
          provider: "aws",
          endpoint: "https://s3.us-east-1.amazonaws.com",
          region: "eu-west-1; curl evil",
          bucket: "fine",
          accessKey: "a",
          secretKey: "s",
        }),
      /region/i,
    );
  });
});
