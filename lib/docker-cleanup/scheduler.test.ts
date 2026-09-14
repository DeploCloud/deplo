import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { dockerCleanupRuns as runsTable } from "../db/schema/control-plane/docker-cleanup";
import { seedIdentity, TEAM_A, USER_1 } from "../data/identity-test-helpers";
import { seedServer, SERVER_1 } from "../data/app-graph-test-helpers";
import {
  seedCleanupPolicy,
  seedCleanupRun,
  TRUNCATE_CLEANUP,
} from "../data/docker-cleanup-test-helpers";
import { runWithIdentity } from "../auth/request-context";

let db: TestDb;
let pg: PGlite;
let scheduler: typeof import("./scheduler");
let lease: typeof import("../backups/lease");

// A second host, so "excluded" and "swept" can be told apart in one tick.
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
  // Reset the globalThis scheduler singleton (its lastFired map + the lease it holds) so a fired sweep can't bleed across tests.
  await scheduler.__stopDockerCleanupScheduler();
  await pg.exec(`${TRUNCATE_CLEANUP}
    truncate table activities, servers, users, teams restart identity cascade;`);
  await seedIdentity(db, {
    users: [{ id: USER_1, teamId: TEAM_A, role: "owner" }],
  });
  // Provisioned on purpose: these cases are about the schedule, not about enrolment.
  await seedServer(db, SERVER_1, { provisioned: true });
  await seedServer(db, SERVER_2, { provisioned: true });
  lease.__resetLocalLeases();
});

const NOW = new Date("2026-06-23T12:00:00Z");

// A cron that matches every minute, so "did it fire?" is about the OTHER predicates.
const EVERY_MINUTE = "* * * * *";
// Due at 03:00 UTC; NOW is 12:00, so cronMatches is false and only catch-up can fire.
const NOT_NOW = "0 3 * * *";

// The tick runs session-free; give the data layer a principal anyway so an incidental read still has a team.
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
  // It failed (no agent on the seeded server), but the run row proves the unattended executor ran end to end.
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

  assert.equal(
    (await runsFor(SERVER_1)).length,
    0,
    "the opted-out host sat the sweep out",
  );
  assert.equal(
    (await runsFor(SERVER_2)).length,
    1,
    "its neighbour still swept",
  );
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
  await seedCleanupPolicy(db, { enabled: true, schedule: NOT_NOW });
  // SERVER_1 was last swept 26h ago - past the 25h catch-up window, so it is OVERDUE.
  await seedCleanupRun(db, {
    id: "dcr_old",
    serverId: SERVER_1,
    status: "success",
    startedAt: new Date(NOW.getTime() - 26 * 60 * 60_000).toISOString(),
  });
  // SERVER_2 is inside the window: the control, since a host with no runs at all is overdue by construction.
  await seedCleanupRun(db, {
    id: "dcr_recent",
    serverId: SERVER_2,
    status: "success",
    startedAt: new Date(NOW.getTime() - 60 * 60_000).toISOString(),
  });

  await tick(NOW);

  const s1 = await runsFor(SERVER_1);
  assert.equal(
    s1.length,
    2,
    "the overdue host ran LATE rather than not at all",
  );
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
  // Two concurrent sweeps on one host race each other's candidate lists, so the tick must skip a running one.
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
  assert.equal(
    (await runsFor(SERVER_2)).length,
    1,
    "the idle host still swept",
  );
});

test("the cleanup lease and the backup lease are independent", async () => {
  await seedCleanupPolicy(db, { enabled: true, schedule: EVERY_MINUTE });

  // Another instance holds the CLEANUP lease: this tick must do nothing, or a scaled deploy runs `docker rmi` N times on one host.
  assert.equal(
    await lease.acquireLease(
      lease.DOCKER_CLEANUP_LEASE,
      "another-instance",
      NOW,
    ),
    true,
  );

  await tick(NOW);
  assert.equal(
    (await runsFor(SERVER_1)).length,
    0,
    "no sweep while the cleanup lease is held elsewhere",
  );

  // The two are separate rows in `scheduler_lease`, so a long nightly dump must not block cleanup.
  await lease.releaseLease(lease.DOCKER_CLEANUP_LEASE, "another-instance");
  assert.equal(
    await lease.acquireLease(
      lease.BACKUP_SCHEDULER_LEASE,
      "another-instance",
      NOW,
    ),
    true,
  );

  await tick(new Date(NOW.getTime() + 60_000)); // a fresh minute, past the dedup guard
  assert.equal(
    (await runsFor(SERVER_1)).length,
    1,
    "a foreign BACKUP lease does not block the cleanup tick",
  );
});
