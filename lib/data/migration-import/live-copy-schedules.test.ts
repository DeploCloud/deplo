import {
  asOwner,
  closeHarness,
  openHarness,
  resetHarness,
  seedRunItems,
} from "../migration-data/migration-data-test-helpers";

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { eq } from "drizzle-orm";

import type { TestDb } from "../../db/test-harness";
import { getDb } from "../../db/client";
import { backups as backupsTable } from "../../db/schema/control-plane/backups";
import { cronJobs as cronsTable } from "../../db/schema/control-plane/crons";
import { migrationRunItems as itemsTable } from "../../db/schema/control-plane/migration";
import { TEAM_A } from "../identity-test-helpers";
import { seedBackup, seedDestination } from "../backup-test-helpers";
import { beginMigration } from "./run-lifecycle";
import { pauseCopiedSchedules } from "./live-copy-schedules";

let db: TestDb;

before(async () => {
  db = await openHarness();
});

after(closeHarness);

async function seedCron(
  id: string,
  on: { appId?: string; databaseId?: string },
) {
  await db.insert(cronsTable).values({
    id,
    teamId: TEAM_A,
    targetKind: on.appId ? "app" : "database",
    appId: on.appId ?? null,
    databaseId: on.databaseId ?? null,
    name: id,
    schedule: "*/5 * * * *",
    command: "echo hi",
    enabled: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
}

beforeEach(async () => {
  await resetHarness();
  await db.execute(
    "truncate table cron_jobs, backups, backup_destination cascade;",
  );
  await seedDestination(db, { id: "dest_s3" });
  await seedCron("cron_web", { appId: "prj_web" });
  await seedCron("cron_db", { databaseId: "db_blink" });
  await seedCron("cron_elsewhere", { appId: "prj_stack" });
  await seedBackup(db, {
    id: "bk_db",
    targetKind: "database",
    databaseId: "db_blink",
    destinationId: "dest_s3",
  });
});

async function run(): Promise<string> {
  const runId = await asOwner(() =>
    beginMigration({ url: "https://old.deplo.test", kind: "deplo" }),
  );
  await seedRunItems(runId, [
    {
      sourceKind: "application",
      sourceId: "src_web",
      sourceName: "blink-web",
      targetKind: "app",
      targetId: "prj_web",
    },
    {
      sourceKind: "postgres",
      sourceId: "src_db",
      sourceName: "blink-db",
      targetKind: "database",
      targetId: "db_blink",
    },
  ]);
  return runId;
}

const enabled = async () =>
  Object.fromEntries([
    ...(
      await getDb()
        .select({ id: cronsTable.id, on: cronsTable.enabled })
        .from(cronsTable)
    ).map((r) => [r.id, r.on]),
    ...(
      await getDb()
        .select({ id: backupsTable.id, on: backupsTable.enabled })
        .from(backupsTable)
    ).map((r) => [r.id, r.on]),
  ]);

test("a copy that keeps the source running lands its crons and backup schedules paused, and says so", async () => {
  const runId = await run();
  await asOwner(() => pauseCopiedSchedules(runId));
  assert.deepEqual(await enabled(), {
    cron_web: false,
    cron_db: false,
    cron_elsewhere: true,
    bk_db: false,
  });
  const report = (
    await getDb()
      .select({ message: itemsTable.message, blocking: itemsTable.blocking })
      .from(itemsTable)
      .where(eq(itemsTable.runId, runId))
  ).filter((r) => /paused/.test(r.message ?? ""));
  assert.equal(report.length, 2);
  assert.ok(report.every((r) => !r.blocking));
  assert.match(
    report.map((r) => r.message).join("\n"),
    /1 cron and 1 backup schedule came across paused/,
  );
});

test("pausing twice says nothing new", async () => {
  const runId = await run();
  await asOwner(() => pauseCopiedSchedules(runId));
  await asOwner(() => pauseCopiedSchedules(runId));
  const lines = (
    await getDb()
      .select({ message: itemsTable.message })
      .from(itemsTable)
      .where(eq(itemsTable.runId, runId))
  ).filter((r) => /paused/.test(r.message ?? ""));
  assert.equal(lines.length, 2);
});
