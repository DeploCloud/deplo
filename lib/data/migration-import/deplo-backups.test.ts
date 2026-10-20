import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../../db/test-harness";
import { backupDestination as destTable } from "../../db/schema/control-plane/backups";
import { migrationRunItems as itemsTable } from "../../db/schema/control-plane/migration";
import { servers as serversTable } from "../../db/schema/control-plane/servers";
import { decryptSecret } from "../../crypto";
import { SERVER_1 } from "../app-graph-test-helpers";
import { seedDestination } from "../backup-test-helpers";
import {
  deploExport,
  exportDatabase,
} from "../../migration/deplo/deplo-test-helpers";
import type { DeploExport } from "../../migration/deplo/export-shape";
import {
  openMigrationHarness,
  closeMigrationHarness,
  resetMigrationHarness,
} from "./migration-import-test-helpers";
import {
  DEPLO_SOURCE,
  importDeploProject,
  fakeDeplo,
} from "./deplo-import-test-helpers";

let db: TestDb;
let pg: PGlite;

const BUCKET_KEY =
  "AGE-SECRET-KEY-1YFFUKFGEQK6JTQK4CWXZAXLJ3HGN9C302UV7MQS78QMHAKPHUZSS049R9A";
const DISK_KEY =
  "AGE-SECRET-KEY-1GYFMF6JL6NW59WNN55M358489HLULP8UNXRQ7QAX8L0MM77KQ66QA4ZTV0";

function withBackups(): DeploExport {
  return deploExport({
    apps: [],
    servers: [
      { id: "srv_old", name: "old-box", address: null, isDeploHost: true },
    ],
    destinations: [
      {
        name: "bucket",
        endpoint: "https://s3.acme.test",
        bucket: "backups",
        region: "eu-west-1",
        accessKeyId: "AK",
        secretAccessKey: "SK",
        provider: "aws",
        ageIdentity: BUCKET_KEY,
      },
    ],
    serverDestinations: [
      {
        name: "disk",
        serverId: "srv_old",
        serverName: "old-box",
        path: null,
        ageIdentity: DISK_KEY,
      },
    ],
    databases: [
      exportDatabase({
        serverId: "srv_old",
        backups: [
          {
            schedule: "0 3 * * *",
            enabled: false,
            timezone: "Europe/Paris",
            retentionCount: 5,
            destination: "bucket",
          },
          {
            schedule: "0 4 * * *",
            enabled: true,
            timezone: "UTC",
            retentionCount: 7,
            destination: "disk",
          },
        ],
        backupRuns: [
          {
            destination: "bucket",
            objectKey: "deplo/team_src/database/db_main/1.sql.gz.age",
            sizeBytes: 2048,
            decryptedSizeBytes: 9000,
            sha256: "abc",
            startedAt: "2026-02-01T03:00:00.000Z",
            finishedAt: "2026-02-01T03:01:00.000Z",
          },
          {
            destination: "disk",
            objectKey: "database/db_main/2.sql.gz.age",
            sizeBytes: 1024,
            decryptedSizeBytes: null,
            sha256: null,
            startedAt: "2026-02-02T04:00:00.000Z",
            finishedAt: null,
          },
        ],
      }),
    ],
  });
}

const notesOf = async (runId: string, kind: string) =>
  (await db.select().from(itemsTable))
    .filter((i) => i.runId === runId && i.sourceKind === kind)
    .map((i) => `${i.outcome}: ${i.message ?? ""}`);

before(async () => {
  ({ db, pg } = await makeTestDb());
  await openMigrationHarness(db);
});

after(() => closeMigrationHarness(db, pg));

beforeEach(async () => {
  await resetMigrationHarness(db);
  await db.execute("truncate table backup_runs, backups cascade;");
  await db.execute("truncate table backup_destination cascade;");
  await db
    .update(serversTable)
    .set({ agentPort: 9443, agentCertFingerprint: "ab".repeat(32) })
    .where(eq(serversTable.id, SERVER_1));
});

test("every destination kind, every schedule and the restore points come across", async () => {
  fakeDeplo(withBackups());
  const runId = await importDeploProject("prc_shop");
  const log = [
    ...(await notesOf(runId, "postgres")),
    ...(await notesOf(runId, "destination")),
  ].join("\n");

  const dests = await db.select().from(destTable);
  const bucket = dests.find((d) => d.name === "bucket");
  const disk = dests.find((d) => d.name === "disk");
  assert.equal(bucket?.kind, "s3", log);
  assert.equal(bucket?.provider, "aws");
  assert.equal(decryptSecret(bucket!.ageIdentityEnc!), BUCKET_KEY);
  assert.equal(disk?.kind, "server", log);
  assert.equal(disk?.serverId, SERVER_1);
  assert.equal(decryptSecret(disk!.ageIdentityEnc!), DISK_KEY);

  const schedules = await db.execute(
    "select b.schedule, b.enabled, b.timezone, b.retention_count, d.name as dest from backups b join backup_destination d on d.id = b.destination_id order by b.schedule",
  );
  assert.deepEqual(
    schedules.rows,
    [
      {
        schedule: "0 3 * * *",
        enabled: false,
        timezone: "Europe/Paris",
        retention_count: 5,
        dest: "bucket",
      },
      {
        schedule: "0 4 * * *",
        enabled: true,
        timezone: "UTC",
        retention_count: 7,
        dest: "disk",
      },
    ],
    log,
  );

  const runs = await db.execute(
    "select r.object_key, r.copied_from, r.status, r.size_bytes::int as size, r.sha256, r.target_kind, r.database_id is not null as linked, d.name as dest from backup_runs r join backup_destination d on d.id = r.destination_id",
  );
  assert.deepEqual(
    runs.rows,
    [
      {
        object_key: "deplo/team_src/database/db_main/1.sql.gz.age",
        copied_from: DEPLO_SOURCE.url,
        status: "success",
        size: 2048,
        sha256: "abc",
        target_kind: "database",
        linked: true,
        dest: "bucket",
      },
    ],
    log,
  );
  assert.match(log, /1 restore point on bucket came across/);
  assert.match(log, /1 restore point on disk did not come across: .*old-box/);

  const again = await importDeploProject("prc_shop");
  const count = await db.execute("select count(*)::int as n from backup_runs");
  assert.equal(count.rows[0]!.n, 1, (await notesOf(again, "postgres")).join());
});

test("restore points stay off a bucket already here that encrypts with another key", async () => {
  await seedDestination(db, { id: "dst_here", name: "mine" });
  await db
    .update(destTable)
    .set({ endpoint: "https://s3.acme.test", bucket: "backups" })
    .where(eq(destTable.id, "dst_here"));
  fakeDeplo(withBackups());
  const runId = await importDeploProject("prc_shop");
  const log = (await notesOf(runId, "postgres")).join("\n");

  const runs = await db.execute("select count(*)::int as n from backup_runs");
  assert.equal(runs.rows[0]!.n, 0, log);
  assert.match(
    log,
    /1 restore point on bucket did not come across: mine, .*different key/,
  );
});
