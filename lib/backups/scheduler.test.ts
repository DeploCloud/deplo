import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { backupRuns as backupRunsTable } from "../db/schema/control-plane/backups";
import { seedIdentity, TEAM_A, USER_1 } from "../data/identity-test-helpers";
import { seedServer } from "../data/app-graph-test-helpers";
import {
  seedBackup,
  seedDatabase,
  seedS3,
  TRUNCATE_BACKUPS,
} from "../data/backup-test-helpers";
import { runWithIdentity } from "../auth/request-context";

let db: TestDb;
let pg: PGlite;
let scheduler: typeof import("./scheduler");
let lease: typeof import("./lease");

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
  scheduler = await import("./scheduler");
  lease = await import("./lease");
});

after(async () => {
  __resetTestDb();
  await pg.close();
});

beforeEach(async () => {
  await scheduler.__stopBackupScheduler();
  await pg.exec(`${TRUNCATE_BACKUPS}
    truncate table app_build_method_settings, app_build, apps, servers,
      users, teams restart identity cascade;`);
  await seedIdentity(db, {
    users: [{ id: USER_1, teamId: TEAM_A, role: "owner" }],
  });
  await seedServer(db);
  await seedDatabase(db, { id: "db_x", name: "x" });
  await seedS3(db, { id: "s3_1" });
  lease.__resetLocalLeases();
});

async function seedDue(
  id: string,
  over: Parameters<typeof seedBackup>[1] | object = {},
) {
  return seedBackup(db, {
    id,
    destinationId: "s3_1",
    databaseId: "db_x",
    schedule: "* * * * *",
    ...(over as object),
  });
}

const runsFor = (backupId: string) =>
  db
    .select()
    .from(backupRunsTable)
    .where(eq(backupRunsTable.backupId, backupId));

const NOW = new Date("2026-06-23T12:00:00Z");

const tick = (now: Date) =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, () =>
    scheduler.runSchedulerTick(now),
  );

test("a due, enabled schedule fires exactly once per tick", async () => {
  await seedDue("bkp_1");

  await tick(NOW);

  const runs = await runsFor("bkp_1");
  assert.equal(runs.length, 1, "one BackupRun recorded for the due schedule");
  assert.equal(runs[0]!.status, "failed");
  assert.equal(runs[0]!.teamId, TEAM_A);
});

test("a disabled schedule and a non-due schedule do not fire", async () => {
  await seedDue("disabled", { enabled: false });
  await seedDue("notDue", { schedule: "0 3 * * *" });

  await tick(NOW);

  assert.equal((await runsFor("disabled")).length, 0);
  assert.equal((await runsFor("notDue")).length, 0);
});

test("dedup: two ticks in the same minute fire a schedule only once", async () => {
  await seedDue("bkp_1");

  await tick(NOW);
  await tick(new Date(NOW.getTime() + 5_000));

  assert.equal(
    (await runsFor("bkp_1")).length,
    1,
    "second same-minute tick is deduped",
  );
});

test("a new minute fires the schedule again", async () => {
  await seedDue("bkp_1");

  await tick(NOW);
  await tick(new Date(NOW.getTime() + 60_000));

  assert.equal(
    (await runsFor("bkp_1")).length,
    2,
    "a distinct minute re-fires",
  );
});

test("the lease prevents a double-run: a tick that can't claim it does nothing", async () => {
  await seedDue("bkp_1");

  const held = await lease.acquireLease(
    lease.BACKUP_SCHEDULER_LEASE,
    "another-instance",
    NOW,
  );
  assert.equal(held, true);

  await tick(NOW);

  assert.equal(
    (await runsFor("bkp_1")).length,
    0,
    "no run fired while the lease is held elsewhere",
  );
});

test("a malformed cron in a schedule never fires and never throws", async () => {
  await seedDue("bkp_1", { schedule: "not a cron" });

  await tick(NOW);

  assert.equal((await runsFor("bkp_1")).length, 0);
});

test("a schedule fires on its own timezone's clock", async () => {
  await seedDue("rome", { schedule: "0 3 * * *", timezone: "Europe/Rome" });

  await tick(new Date("2026-06-23T03:00:00Z"));
  assert.equal(
    (await runsFor("rome")).length,
    0,
    "03:00 UTC is not 03:00 in Rome",
  );

  await tick(new Date("2026-06-23T01:00:00Z"));
  assert.equal((await runsFor("rome")).length, 1, "fired on Rome's own clock");
});

test("a schedule with an unusable timezone is skipped, not fatal", async () => {
  await seedDue("broken", { timezone: "Mars/Olympus" });
  await seedDue("fine");

  await tick(NOW);

  assert.equal((await runsFor("broken")).length, 0, "the bad row is skipped");
  assert.equal((await runsFor("fine")).length, 1, "the good one still fires");
});

test("a daily schedule fires ONCE across a repeated wall-clock hour", async () => {
  await seedDue("nightly", { schedule: "30 2 * * *", timezone: "Europe/Rome" });

  await tick(new Date("2026-10-25T00:30:00Z"));
  await tick(new Date("2026-10-25T01:30:00Z"));

  assert.equal(
    (await runsFor("nightly")).length,
    1,
    "one nightly backup, not two, across the repeated hour",
  );
});
