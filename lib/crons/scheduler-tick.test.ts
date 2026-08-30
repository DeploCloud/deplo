import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { seedIdentity, TEAM_A, USER_1 } from "../data/identity-test-helpers";
import { seedApp, seedServer } from "../data/app-graph-test-helpers";
import {
  enableCrons,
  FakeAgent,
  runsOf,
  seedCronJob,
  TRUNCATE_CRONS,
} from "../data/cron-test-helpers";
import { __resetCronConnector, __setCronConnector } from "./runner";
import {
  runCronSchedulerTick,
  shouldFire,
  __stopCronScheduler,
} from "./scheduler";
import * as lease from "../backups/lease";

/**
 * The TICK's cadence, which is the part `scheduler.test.ts` cannot see: it calls
 * the two phases directly, so it would pass just as well if they ran at the same
 * rate. They must not.
 */

let db: TestDb;
let pg: PGlite;
let agent: FakeAgent;

const T0 = new Date("2026-07-15T01:00:00.000Z");
const at = (ms: number) => new Date(T0.getTime() + ms);

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
});

after(async () => {
  __resetCronConnector();
  await __stopCronScheduler();
  __resetTestDb();
  await pg.close();
});

beforeEach(async () => {
  await __stopCronScheduler();
  lease.__resetLocalLeases();
  await pg.exec(`${TRUNCATE_CRONS}
    truncate table app_build_method_settings, app_build, apps, servers,
      users, teams restart identity cascade;`);
  await seedIdentity(db, {
    users: [{ id: USER_1, teamId: TEAM_A, role: "owner" }],
  });
  await seedServer(db);
  await seedApp(db, { id: "prj_1", slug: "web" });
  await enableCrons(db, "app", "prj_1");
  agent = new FakeAgent();
  __setCronConnector(agent.connector);
});

test("shouldFire lets one tick per wall-clock minute through", () => {
  assert.equal(shouldFire(T0, null), true, "the first tick always fires");
  assert.equal(shouldFire(at(5_000), T0), false, "the ticks underneath do not");
  assert.equal(shouldFire(at(59_999), T0), false);
  assert.equal(shouldFire(at(60_000), T0), true, "the next minute does");
  // A backwards clock step lands in a different minute, so it fires - and the
  // unique index is what keeps that from being a second run of the same minute.
  assert.equal(shouldFire(at(-60_000), T0), true);
});

test("a run settles within one tick, not one minute", async () => {
  await seedCronJob(db, { id: "cron_1" });
  await runCronSchedulerTick(T0);
  assert.equal((await runsOf(db, "cron_1"))[0].status, "running");

  // The command is over 200ms later. The next TICK is what has to notice - a
  // page that shows "Running" for another 59 seconds is the bug this fixes.
  agent.settleAll({ exitCode: 0, stdout: "done\n" });
  await runCronSchedulerTick(at(5_000));

  const runs = await runsOf(db, "cron_1");
  assert.equal(runs.length, 1, "and reaping did not fire a second time");
  assert.equal(runs[0].status, "succeeded");
  assert.equal(runs[0].stdout, "done\n");
});

test("the ticks inside a minute never fire again", async () => {
  await seedCronJob(db, { id: "cron_1", overlap: "allow" });
  // Twelve ticks, one minute. Overlap=allow so nothing but the cadence itself
  // can be what stops a second run.
  for (let i = 0; i < 12; i++) await runCronSchedulerTick(at(i * 5_000));
  assert.equal((await runsOf(db, "cron_1")).length, 1);
  assert.equal(agent.started.length, 1);

  await runCronSchedulerTick(at(60_000));
  assert.equal((await runsOf(db, "cron_1")).length, 2, "the next minute fires");
});

test("a minute stepped over during a long drain is still replayed", async () => {
  await seedCronJob(db, {
    id: "cron_1",
    schedule: "2 1 * * *",
    timezone: "UTC",
  });
  await runCronSchedulerTick(T0); // 01:00 - not due
  assert.equal((await runsOf(db, "cron_1")).length, 0);

  // The next tick to fire lands three minutes late (a drain that outran the
  // interval). 01:02 fell inside it and must not be lost.
  await runCronSchedulerTick(at(3 * 60_000));
  const runs = await runsOf(db, "cron_1");
  assert.equal(runs.length, 1);
  assert.equal(runs[0].scheduledFor, at(2 * 60_000).toISOString());
});

test("a run in flight does not starve the next minute under overlap=skip", async () => {
  await seedCronJob(db, { id: "cron_1", overlap: "skip" });
  await runCronSchedulerTick(T0);
  agent.settleAll({ exitCode: 0 });
  await runCronSchedulerTick(at(5_000)); // reaps it

  agent.nextState = { found: true, running: true };
  await runCronSchedulerTick(at(60_000));
  const runs = await runsOf(db, "cron_1");
  assert.equal(runs.length, 2);
  assert.equal(runs[1].status, "running", "the finished run blocks nothing");
  assert.equal(agent.started.length, 2);
});
