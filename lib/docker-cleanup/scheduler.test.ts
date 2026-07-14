import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { dockerCleanupRuns as runsTable } from "../db/schema/control-plane";
import { seedIdentity, TEAM_A, USER_1 } from "../data/identity-test-helpers";
import { seedServer, SERVER_1 } from "../data/app-graph-test-helpers";
import {
  seedCleanupPolicy,
  seedCleanupRun,
  TRUNCATE_CLEANUP,
} from "../data/docker-cleanup-test-helpers";
import { runWithIdentity } from "../auth/request-context";

/**
 * Scheduler-tick tests for the Docker cleanup loop — the sibling of
 * `lib/backups/scheduler.test.ts`, and shaped like it: these exercise the
 * ORCHESTRATION (due selection, the exclusion list, the per-minute dedup guard, the
 * never-stack-runs check, the cross-process lease) and NOT a real `docker` sweep.
 *
 * The proof that a tick FIRED a server is a cleanup-run row: the seeded servers have
 * no agent, so `executeCleanup` gets as far as the provisioning check and records a
 * `failed` run — which is exactly the "history never lies" path, driven here with no
 * request context at all.
 *
 * Two behaviours here have no counterpart in the backup scheduler and are the reason
 * this file exists rather than a copy of it:
 *   - CATCH-UP: a host overdue by >25h fires even on a minute the cron does not match,
 *   - the instance-wide policy + per-server EXCLUSION list (backups are per-schedule).
 *
 * With no DEPLO_DATABASE_URL the lease takes its in-process path — the single-process
 * `next start` shape the scheduler targets — while the data layer reads the injected
 * pglite client (`__setTestDb`).
 */

let db: TestDb;
let pg: PGlite;
let scheduler: typeof import("./scheduler");
let lease: typeof import("../backups/lease");

/** A second host, so "excluded" and "swept" can be told apart in one tick. */
const SERVER_2 = "srv_2";

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
  scheduler = await import("./scheduler");
  lease = await import("../backups/lease");
});

after(async () => {
  __resetTestDb();
  await pg.close();
});

beforeEach(async () => {
  // Reset the globalThis scheduler singleton (its per-minute `lastFired` dedup map +
  // the lease it holds) so a previous case's fired sweep can't bleed across tests.
  await scheduler.__stopDockerCleanupScheduler();
  await pg.exec(`${TRUNCATE_CLEANUP}
    truncate table activities, servers, users, teams restart identity cascade;`);
  await seedIdentity(db, { users: [{ id: USER_1, teamId: TEAM_A, role: "owner" }] });
  await seedServer(db, SERVER_1);
  await seedServer(db, SERVER_2);
  lease.__resetLocalLeases();
});

const NOW = new Date("2026-06-23T12:00:00Z");

/** A cron that matches every minute — so "did it fire?" is about the OTHER predicates. */
const EVERY_MINUTE = "* * * * *";
/** Due at 03:00 UTC; NOW is 12:00, so `cronMatches` is false and only catch-up can fire. */
const NOT_NOW = "0 3 * * *";

// The tick runs session-free; give the data layer a principal anyway, as the backup
// scheduler test does, so any incidental cookie-free read still has a team.
const tick = (now: Date) =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, () =>
    scheduler.runCleanupSchedulerTick(now),
  );

const runsFor = (serverId: string) =>
  db.select().from(runsTable).where(eq(runsTable.serverId, serverId));

test("an enabled policy sweeps a non-excluded server", async () => {
  await seedCleanupPolicy(db, { enabled: true, schedule: EVERY_MINUTE });

  await tick(NOW);

  const runs = await runsFor(SERVER_1);
  assert.equal(runs.length, 1, "one cleanup run recorded for the due server");
  // It failed (no agent on the seeded server) — but the run row is the proof that the
  // unattended executor ran end to end, with no session and no cookies.
  assert.equal(runs[0]!.status, "failed");
  assert.equal(runs[0]!.trigger, "scheduled");
  assert.equal(runs[0]!.actor, "Scheduler");
});

test("an excluded server is never swept by the schedule", async () => {
  await seedCleanupPolicy(db, {
    enabled: true,
    schedule: EVERY_MINUTE,
    excludedServerIds: [SERVER_1],
  });

  await tick(NOW);

  assert.equal((await runsFor(SERVER_1)).length, 0, "the opted-out host sat the sweep out");
  assert.equal((await runsFor(SERVER_2)).length, 1, "its neighbour still swept");
});

test("dedup: two ticks in the same minute sweep a server only once", async () => {
  await seedCleanupPolicy(db, { enabled: true, schedule: EVERY_MINUTE });

  await tick(NOW);
  await tick(new Date(NOW.getTime() + 5_000)); // same wall-clock minute

  assert.equal(
    (await runsFor(SERVER_1)).length,
    1,
    "the second same-minute tick is deduped",
  );
});

test("a disabled policy never sweeps", async () => {
  await seedCleanupPolicy(db, { enabled: false, schedule: EVERY_MINUTE });

  await tick(NOW);

  assert.equal((await runsFor(SERVER_1)).length, 0);
  assert.equal((await runsFor(SERVER_2)).length, 0);
});

test("catch-up: a server overdue by 26h sweeps even when the cron does not match", async () => {
  // The policy is due at 03:00; NOW is 12:00. Nothing here is "on time".
  await seedCleanupPolicy(db, { enabled: true, schedule: NOT_NOW });
  // SERVER_1 was last swept 26h ago — past the 25h catch-up window, so it is OVERDUE.
  await seedCleanupRun(db, {
    id: "dcr_old",
    serverId: SERVER_1,
    status: "success",
    startedAt: new Date(NOW.getTime() - 26 * 60 * 60_000).toISOString(),
  });
  // SERVER_2 was swept an hour ago — inside the window, so it is NOT overdue. This is
  // the control: without it, "it fired" would prove nothing, since a host with no runs
  // at all is overdue by construction.
  await seedCleanupRun(db, {
    id: "dcr_recent",
    serverId: SERVER_2,
    status: "success",
    startedAt: new Date(NOW.getTime() - 60 * 60_000).toISOString(),
  });

  await tick(NOW);

  const s1 = await runsFor(SERVER_1);
  assert.equal(s1.length, 2, "the overdue host ran LATE rather than not at all");
  assert.equal(
    s1.filter((r) => r.trigger === "scheduled").length,
    1,
    "exactly one new scheduled run",
  );
  assert.equal(
    (await runsFor(SERVER_2)).length,
    1,
    "the recently-swept host waited for its cron minute",
  );
});

test("a server with a run already in flight does not stack a second one", async () => {
  await seedCleanupPolicy(db, { enabled: true, schedule: EVERY_MINUTE });
  // A sweep already running on SERVER_1 (the row the boot reconcile would settle if the
  // process had died). Two concurrent `docker rmi` sweeps on one host would race each
  // other's candidate lists, so the tick must skip it.
  await seedCleanupRun(db, {
    id: "dcr_inflight",
    serverId: SERVER_1,
    status: "running",
    startedAt: NOW.toISOString(),
  });

  await tick(NOW);

  const s1 = await runsFor(SERVER_1);
  assert.equal(s1.length, 1, "no second run stacked on the busy host");
  assert.equal(s1[0]!.id, "dcr_inflight");
  assert.equal(s1[0]!.status, "running", "and the in-flight run is left alone");
  assert.equal((await runsFor(SERVER_2)).length, 1, "the idle host still swept");
});

test("the cleanup lease and the backup lease are independent", async () => {
  await seedCleanupPolicy(db, { enabled: true, schedule: EVERY_MINUTE });

  // Another live instance holds the CLEANUP lease → this tick must do nothing, or a
  // horizontally-scaled deploy would run `docker rmi` N times on the same host.
  assert.equal(
    await lease.acquireLease(lease.DOCKER_CLEANUP_LEASE, "another-instance", NOW),
    true,
  );

  await tick(NOW);
  assert.equal(
    (await runsFor(SERVER_1)).length,
    0,
    "no sweep while the cleanup lease is held elsewhere",
  );

  // Now hand the cleanup lease back but hold the BACKUP one instead. The two are
  // separate rows in `scheduler_lease`, so a long nightly dump must not block cleanup.
  await lease.releaseLease(lease.DOCKER_CLEANUP_LEASE, "another-instance");
  assert.equal(
    await lease.acquireLease(lease.BACKUP_SCHEDULER_LEASE, "another-instance", NOW),
    true,
  );

  await tick(new Date(NOW.getTime() + 60_000)); // a fresh minute, past the dedup guard
  assert.equal(
    (await runsFor(SERVER_1)).length,
    1,
    "a foreign BACKUP lease does not block the cleanup tick",
  );
});
