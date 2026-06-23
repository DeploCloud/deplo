import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Scheduler-tick tests (Step 6). These exercise the ORCHESTRATION — due
 * selection, the per-minute dedup guard, and the cross-process lease — not a real
 * dump. The schedules here point at a destination that doesn't exist, so
 * `executeBackup` fails fast at the (session-free) creds lookup and records a
 * `failed` BackupRun WITHOUT any network: the run record is our proof the tick
 * fired that schedule. The cron matcher + lease CAS have their own focused tests.
 *
 * With no DEPLO_DATABASE_URL the store runs in its test-only in-memory mode and
 * the lease takes its in-process path — exactly the single-process `next start`
 * shape Step 6 targets.
 */

// No DEPLO_DATABASE_URL → in-memory store (test-only). DEPLO_DATA_DIR points
// build/upload staging at a throwaway dir; set BEFORE the modules load.
const dataDir = mkdtempSync(join(tmpdir(), "deplo-sched-"));
process.env.DEPLO_DATA_DIR = dataDir;
delete process.env.DEPLO_DATABASE_URL;
delete process.env.DATABASE_URL;

let store: typeof import("../store");
let scheduler: typeof import("./scheduler");
let lease: typeof import("./lease");
import type { Backup } from "../types";

before(async () => {
  store = await import("../store");
  scheduler = await import("./scheduler");
  lease = await import("./lease");
});

after(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

const TEAM = "team_sched";

/** A backup schedule targeting a database, pointed at a missing destination. */
function makeBackup(over: Partial<Backup> = {}): Backup {
  return {
    id: `bkp_${Math.random().toString(16).slice(2)}`,
    teamId: TEAM,
    name: "nightly",
    targetKind: "database",
    databaseId: "db_x",
    projectId: null,
    destinationId: "s3_missing", // does not exist → executeBackup fails fast
    schedule: "* * * * *", // due every minute
    retentionDays: 7,
    lastRunAt: null,
    lastStatus: "never",
    enabled: true,
    createdAt: new Date("2026-01-01T00:00:00Z").toISOString(),
    ...over,
  };
}

beforeEach(() => {
  // Fresh store + a clean in-process lease before each case.
  store.reseed();
  lease.__resetLocalLeases();
});

const runsFor = (id: string) =>
  store.read().backupRuns.filter((r) => r.backupId === id);

const NOW = new Date("2026-06-23T12:00:00Z");

test("a due, enabled schedule fires exactly once per tick", async () => {
  const b = makeBackup();
  store.mutate((d) => d.backups.push(b));

  await scheduler.runSchedulerTick(NOW);

  const runs = runsFor(b.id);
  assert.equal(runs.length, 1, "one BackupRun recorded for the due schedule");
  // It failed (missing destination) but the schedule's lastStatus reflects it —
  // proof the unattended executor ran end to end without a session.
  assert.equal(runs[0].status, "failed");
  assert.equal(runs[0].teamId, TEAM);
});

test("a disabled schedule and a non-due schedule do not fire", async () => {
  const disabled = makeBackup({ enabled: false });
  // Due only at 03:00; NOW is 12:00.
  const notDue = makeBackup({ schedule: "0 3 * * *" });
  store.mutate((d) => d.backups.push(disabled, notDue));

  await scheduler.runSchedulerTick(NOW);

  assert.equal(runsFor(disabled.id).length, 0);
  assert.equal(runsFor(notDue.id).length, 0);
});

test("dedup: two ticks in the same minute fire a schedule only once", async () => {
  const b = makeBackup();
  store.mutate((d) => d.backups.push(b));

  await scheduler.runSchedulerTick(NOW);
  await scheduler.runSchedulerTick(new Date(NOW.getTime() + 5_000)); // same minute

  assert.equal(runsFor(b.id).length, 1, "second same-minute tick is deduped");
});

test("a new minute fires the schedule again", async () => {
  const b = makeBackup();
  store.mutate((d) => d.backups.push(b));

  await scheduler.runSchedulerTick(NOW);
  await scheduler.runSchedulerTick(new Date(NOW.getTime() + 60_000)); // next minute

  assert.equal(runsFor(b.id).length, 2, "a distinct minute re-fires");
});

test("the lease prevents a double-run: a tick that can't claim it does nothing", async () => {
  const b = makeBackup();
  store.mutate((d) => d.backups.push(b));

  // Simulate another live instance already holding the scheduler lease.
  const held = await lease.acquireLease(
    lease.BACKUP_SCHEDULER_LEASE,
    "another-instance",
    NOW,
  );
  assert.equal(held, true);

  await scheduler.runSchedulerTick(NOW);

  assert.equal(runsFor(b.id).length, 0, "no run fired while the lease is held elsewhere");
});

test("a malformed cron in a schedule never fires and never throws", async () => {
  const b = makeBackup({ schedule: "not a cron" });
  store.mutate((d) => d.backups.push(b));

  await scheduler.runSchedulerTick(NOW); // must not throw

  assert.equal(runsFor(b.id).length, 0);
});
