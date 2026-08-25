import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { backupRuns as backupRunsTable } from "../db/schema/control-plane";
import { seedIdentity, TEAM_A, USER_1 } from "../data/identity-test-helpers";
import { seedServer } from "../data/app-graph-test-helpers";
import {
  seedBackup,
  seedDatabase,
  seedS3,
  TRUNCATE_BACKUPS,
} from "../data/backup-test-helpers";
import { runWithIdentity } from "../auth/request-context";

/**
 * Scheduler-tick tests (PLAN Step 5 cut-set (d) — the scheduler-test rewrite off
 * the deleted `store.read/mutate` onto the Drizzle test harness).
 */

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
  // Reset the globalThis scheduler singleton (its per-minute `lastFired` dedup map
  // + held lease) so a previous case's fired schedule can't bleed across tests.
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

/** Seed a due-every-minute schedule (overridable). Returns its id. */
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

// The scheduler runs session-free; give the data layer a principal anyway so any
// incidental cookie-free read has a team (the executor uses the schedule's teamId).
const tick = (now: Date) =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, () =>
    scheduler.runSchedulerTick(now),
  );

test("a due, enabled schedule fires exactly once per tick", async () => {
  await seedDue("bkp_1");

  await tick(NOW);

  const runs = await runsFor("bkp_1");
  assert.equal(runs.length, 1, "one BackupRun recorded for the due schedule");
  // It failed (unreachable agent) but the run record proves the unattended
  // executor ran end to end without a session.
  assert.equal(runs[0]!.status, "failed");
  assert.equal(runs[0]!.teamId, TEAM_A);
});

test("a disabled schedule and a non-due schedule do not fire", async () => {
  await seedDue("disabled", { enabled: false });
  await seedDue("notDue", { schedule: "0 3 * * *" }); // due at 03:00; NOW is 12:00

  await tick(NOW);

  assert.equal((await runsFor("disabled")).length, 0);
  assert.equal((await runsFor("notDue")).length, 0);
});

test("dedup: two ticks in the same minute fire a schedule only once", async () => {
  await seedDue("bkp_1");

  await tick(NOW);
  await tick(new Date(NOW.getTime() + 5_000)); // same minute

  assert.equal(
    (await runsFor("bkp_1")).length,
    1,
    "second same-minute tick is deduped",
  );
});

test("a new minute fires the schedule again", async () => {
  await seedDue("bkp_1");

  await tick(NOW);
  await tick(new Date(NOW.getTime() + 60_000)); // next minute

  assert.equal(
    (await runsFor("bkp_1")).length,
    2,
    "a distinct minute re-fires",
  );
});

test("the lease prevents a double-run: a tick that can't claim it does nothing", async () => {
  await seedDue("bkp_1");

  // Simulate another live instance already holding the scheduler lease.
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

  await tick(NOW); // must not throw

  assert.equal((await runsFor("bkp_1")).length, 0);
});

/* ------------------------------------------------------------------ */
/* A schedule fires on ITS clock, not on UTC                            */
/* ------------------------------------------------------------------ */

test("a schedule fires on its own timezone's clock", async () => {
  // "Nightly at 03:00" used to mean 03:00 UTC whatever the team's clock said,
  // which in Rome is 04:00 for half the year and 05:00 for the other half —
  // with nothing above the field admitting it.
  await seedDue("rome", { schedule: "0 3 * * *", timezone: "Europe/Rome" });

  // 03:00 UTC is 05:00 in Rome in summer: not this schedule's hour.
  await tick(new Date("2026-06-23T03:00:00Z"));
  assert.equal(
    (await runsFor("rome")).length,
    0,
    "03:00 UTC is not 03:00 in Rome",
  );

  // 01:00 UTC is 03:00 in Rome, which is.
  await tick(new Date("2026-06-23T01:00:00Z"));
  assert.equal((await runsFor("rome")).length, 1, "fired on Rome's own clock");
});

test("a schedule with an unusable timezone is skipped, not fatal", async () => {
  // A row that got past validation must not take the instance's other backups
  // down with it — the same containment the cron runner has.
  await seedDue("broken", { timezone: "Mars/Olympus" });
  await seedDue("fine");

  await tick(NOW);

  assert.equal((await runsFor("broken")).length, 0, "the bad row is skipped");
  assert.equal((await runsFor("fine")).length, 1, "the good one still fires");
});

test("a daily schedule fires ONCE across a repeated wall-clock hour", async () => {
  // Fall back replays 02:00-03:00 local, so a daily 02:30 matches at two separate
  // instants. Keyed on the instant it would fire twice; keyed on the wall clock it
  // fires once, which is what "every day at 02:30" means.
  await seedDue("nightly", { schedule: "30 2 * * *", timezone: "Europe/Rome" });

  await tick(new Date("2026-10-25T00:30:00Z")); // 02:30 CEST
  await tick(new Date("2026-10-25T01:30:00Z")); // 02:30 CET — the same wall clock

  assert.equal(
    (await runsFor("nightly")).length,
    1,
    "one nightly backup, not two, across the repeated hour",
  );
});
