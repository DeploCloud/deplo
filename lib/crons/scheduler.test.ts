import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { cronJobs as cronJobsTable, cronRuns as cronRunsTable } from "../db/schema/control-plane";
import { seedIdentity, TEAM_A, USER_1 } from "../data/identity-test-helpers";
import { seedApp, seedServer } from "../data/app-graph-test-helpers";
import {
  enableCrons,
  FakeAgent,
  runsOf,
  seedCronJob,
  TRUNCATE_CRONS,
} from "../data/cron-test-helpers";
import {
  __resetCronConnector,
  __setCronConnector,
  fireDueJobs,
  reapInFlightRuns,
  RETRY_BACKOFF_MS,
} from "./runner";
import { AgentUnreachableError } from "../infra/agent-client";

/**
 * The cron scheduler's orchestration, against pglite with a fake agent.
 *
 * These cover the parts that are genuinely hard to get right and impossible to
 * eyeball: the double-fire guard, the overlap rule's dependence on reap running
 * first, the retry ladder across ticks, and the three ways a run can end without
 * the command having failed (`skipped`, `lost`, and a stopped container).
 */

let db: TestDb;
let pg: PGlite;
let agent: FakeAgent;

const MINUTE = new Date("2026-07-15T01:00:00.000Z");

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
});

after(async () => {
  __resetCronConnector();
  __resetTestDb();
  await pg.close();
});

beforeEach(async () => {
  await pg.exec(`${TRUNCATE_CRONS}
    truncate table app_build_method_settings, app_build, apps, servers,
      users, teams restart identity cascade;`);
  await seedIdentity(db, { users: [{ id: USER_1, teamId: TEAM_A, role: "owner" }] });
  await seedServer(db);
  await seedApp(db, { id: "prj_1", slug: "web" });
  await enableCrons(db, "app", "prj_1");
  agent = new FakeAgent();
  __setCronConnector(agent.connector);
});

const oneRun = async (jobId: string) => {
  const rows = await runsOf(db, jobId);
  assert.equal(rows.length, 1, `expected exactly one run, got ${rows.length}`);
  return rows[0];
};

test("a due job starts on the agent and records a running run", async () => {
  await seedCronJob(db, { id: "cron_1", command: "php artisan schedule:run" });
  await fireDueJobs([MINUTE]);

  const run = await oneRun("cron_1");
  assert.equal(run.status, "running");
  assert.equal(run.trigger, "schedule");
  assert.equal(run.container, "deplo-web");
  // Frozen at insert, so a later edit to the job cannot rewrite history.
  assert.equal(run.command, "php artisan schedule:run");
  assert.equal(agent.started.length, 1);
  assert.equal(agent.started[0].command, "php artisan schedule:run");
});

test("the same minute cannot fire twice, however many instances try", async () => {
  await seedCronJob(db, { id: "cron_1" });
  // Two control-plane instances racing on a stolen lease, or one tick replaying
  // a minute it already covered. The unique key is what makes both harmless.
  await fireDueJobs([MINUTE]);
  await fireDueJobs([MINUTE]);
  await oneRun("cron_1");
  assert.equal(agent.started.length, 1);
});

test("a replay window fires once, on its last matching minute", async () => {
  await seedCronJob(db, { id: "cron_1" });
  // A 5-minute drain: the job matched every minute of it. Late is right; five
  // times is not.
  const window = [0, 1, 2, 3, 4].map((i) => new Date(MINUTE.getTime() + i * 60_000));
  await fireDueJobs(window);

  const run = await oneRun("cron_1");
  assert.equal(run.scheduledFor, window[4].toISOString());
});

test("the master switch stops the schedule and keeps the jobs", async () => {
  await seedCronJob(db, { id: "cron_1" });
  await db.update(cronJobsTable).set({ enabled: true }).where(eq(cronJobsTable.id, "cron_1"));
  await db.execute("update apps set cron_enabled = false");

  await fireDueJobs([MINUTE]);
  assert.equal((await runsOf(db, "cron_1")).length, 0);
  // The job itself is untouched.
  const jobs = await db.select().from(cronJobsTable);
  assert.equal(jobs.length, 1);
});

test("a disabled job does not fire", async () => {
  await seedCronJob(db, { id: "cron_1", enabled: false });
  await fireDueJobs([MINUTE]);
  assert.equal((await runsOf(db, "cron_1")).length, 0);
});

test("the schedule is read in the job's timezone", async () => {
  // 03:00 in Rome is 01:00Z in July. A UTC-only evaluator would miss this minute
  // entirely and fire two hours late.
  await seedCronJob(db, { id: "cron_1", schedule: "0 3 * * *", timezone: "Europe/Rome" });
  await fireDueJobs([MINUTE]);
  await oneRun("cron_1");

  await pg.exec(TRUNCATE_CRONS);
  await seedCronJob(db, { id: "cron_2", schedule: "0 3 * * *", timezone: "UTC" });
  await fireDueJobs([MINUTE]);
  assert.equal((await runsOf(db, "cron_2")).length, 0, "01:00Z is not 03:00 UTC");
});

test("overlap=skip records a skipped run instead of a second execution", async () => {
  await seedCronJob(db, { id: "cron_1", overlap: "skip" });
  await fireDueJobs([MINUTE]);
  await fireDueJobs([new Date(MINUTE.getTime() + 60_000)]);

  const runs = await runsOf(db, "cron_1");
  assert.equal(runs.length, 2);
  assert.equal(runs[0].status, "running");
  assert.equal(runs[1].status, "skipped");
  assert.match(runs[1].error ?? "", /still in progress/);
  // Skipped means never started: the agent saw one StartJob, not two.
  assert.equal(agent.started.length, 1);
});

test("overlap=allow runs them side by side", async () => {
  await seedCronJob(db, { id: "cron_1", overlap: "allow" });
  await fireDueJobs([MINUTE]);
  await fireDueJobs([new Date(MINUTE.getTime() + 60_000)]);

  const runs = await runsOf(db, "cron_1");
  assert.equal(runs.filter((r) => r.status === "running").length, 2);
  assert.equal(agent.started.length, 2);
});

test("a stopped container is skipped, not failed", async () => {
  // An app stopped on purpose must not page anyone at 03:00.
  agent.instances = [{ name: "deplo-web", service: "web", image: "img", running: false }];
  await seedCronJob(db, { id: "cron_1" });
  await fireDueJobs([MINUTE]);

  const run = await oneRun("cron_1");
  assert.equal(run.status, "skipped");
  assert.match(run.error ?? "", /not running/);
  assert.equal(agent.started.length, 0);
});

test("a named service that is not up is skipped by name", async () => {
  agent.instances = [{ name: "deplo-web", service: "web", image: "img", running: true }];
  await seedCronJob(db, { id: "cron_1", service: "worker" });
  await fireDueJobs([MINUTE]);

  const run = await oneRun("cron_1");
  assert.equal(run.status, "skipped");
  assert.match(run.error ?? "", /"worker"/);
});

test("the app's own service is preferred over a healthy sidecar", async () => {
  // A crash-looping app whose Postgres sidecar is fine must not silently run its
  // job inside Postgres.
  agent.instances = [
    { name: "deplo-web-postgres-1", service: "postgres", image: "pg", running: true },
    { name: "deplo-web-web-1", service: "web", image: "img", running: true },
  ];
  await seedCronJob(db, { id: "cron_1" });
  await fireDueJobs([MINUTE]);
  assert.equal(agent.started[0].container, "deplo-web-web-1");
});

test("a clean exit settles as succeeded with its output", async () => {
  await seedCronJob(db, { id: "cron_1" });
  await fireDueJobs([MINUTE]);
  agent.settleAll({ exitCode: 0, stdout: "done\n" });
  await reapInFlightRuns(new Date(MINUTE.getTime() + 60_000));

  const run = await oneRun("cron_1");
  assert.equal(run.status, "succeeded");
  assert.equal(run.exitCode, 0);
  assert.equal(run.stdout, "done\n");
  assert.equal(run.agentJobId, null);
  assert.ok(run.finishedAt);

  const job = (await db.select().from(cronJobsTable).where(eq(cronJobsTable.id, "cron_1")))[0];
  assert.equal(job.lastStatus, "succeeded");
  assert.ok(job.lastSuccessAt, "a success stamps lastSuccessAt for the job row");
});

test("a healthy poll writes nothing at all", async () => {
  await seedCronJob(db, { id: "cron_1" });
  await fireDueJobs([MINUTE]);
  const before = await oneRun("cron_1");
  await reapInFlightRuns(new Date(MINUTE.getTime() + 60_000));
  const after = await oneRun("cron_1");
  assert.deepEqual(after, before, "polling a running job must not touch the row");
});

test("a non-zero exit fails when there are no retries left", async () => {
  await seedCronJob(db, { id: "cron_1", maxAttempts: 1 });
  await fireDueJobs([MINUTE]);
  agent.settleAll({ exitCode: 1, stderr: "boom" });
  await reapInFlightRuns(new Date(MINUTE.getTime() + 60_000));

  const run = await oneRun("cron_1");
  assert.equal(run.status, "failed");
  assert.equal(run.exitCode, 1);
  assert.equal(run.stderr, "boom");
});

test("a retry stays in the SAME row and relaunches after the backoff", async () => {
  await seedCronJob(db, { id: "cron_1", maxAttempts: 2 });
  await fireDueJobs([MINUTE]);
  agent.settleAll({ exitCode: 1, stderr: "first" });

  const t1 = new Date(MINUTE.getTime() + 60_000);
  await reapInFlightRuns(t1);

  let run = await oneRun("cron_1");
  assert.equal(run.status, "running", "a retry never writes a terminal status");
  assert.equal(run.attempt, 1);
  assert.equal(run.agentJobId, null);
  assert.ok(run.nextAttemptAt, "and it records when to try again");

  // Still inside the backoff: nothing relaunches.
  await reapInFlightRuns(new Date(t1.getTime() + 1_000));
  assert.equal(agent.started.length, 1);

  // Past it: the second attempt goes out.
  agent.nextState = { found: true, running: true };
  await reapInFlightRuns(new Date(t1.getTime() + RETRY_BACKOFF_MS + 1_000));
  assert.equal(agent.started.length, 2);
  run = await oneRun("cron_1");
  assert.equal(run.status, "running");
  assert.equal(run.agentJobId, "agentjob_2");

  // The last attempt fails for good.
  agent.settleAll({ exitCode: 2, stderr: "second" });
  await reapInFlightRuns(new Date(t1.getTime() + RETRY_BACKOFF_MS + 120_000));
  run = await oneRun("cron_1");
  assert.equal(run.status, "failed");
  assert.equal(run.attempt, 1, "one row, and it says which attempt produced this");
  assert.equal(run.stderr, "second", "the stored output is the LAST attempt's");
});

test("an agent that lost the job records `lost`, never `failed`", async () => {
  await seedCronJob(db, { id: "cron_1", maxAttempts: 3 });
  await fireDueJobs([MINUTE]);
  // The agent restarted: it has no record of the handle. The command very likely
  // completed, so this must not read as a failure and must NOT be retried —
  // re-running it could double-charge a card.
  agent.jobs.clear();
  await reapInFlightRuns(new Date(MINUTE.getTime() + 60_000));

  const run = await oneRun("cron_1");
  assert.equal(run.status, "lost");
  assert.match(run.error ?? "", /agent restarted/);
  assert.equal(agent.started.length, 1, "`lost` never retries");
});

test("an unreachable agent leaves the run alone until its own deadline", async () => {
  await seedCronJob(db, { id: "cron_1", timeoutSeconds: 300 });
  await fireDueJobs([MINUTE]);
  agent.connectError = new AgentUnreachableError("host down");

  // Twenty minutes of outage on a 5-minute job is still inside timeout+grace at
  // first: the command is probably still running over there.
  await reapInFlightRuns(new Date(MINUTE.getTime() + 60_000));
  assert.equal((await oneRun("cron_1")).status, "running");

  // Past timeout + grace, it is genuinely unaccounted for.
  await reapInFlightRuns(new Date(MINUTE.getTime() + (300 + 120 + 60) * 1000));
  const run = await oneRun("cron_1");
  assert.equal(run.status, "lost");
  assert.match(run.error ?? "", /host down/);
});

test("a run past its deadline is killed and timed out", async () => {
  await seedCronJob(db, { id: "cron_1", timeoutSeconds: 60 });
  await fireDueJobs([MINUTE]);
  // The agent still says running long after its own timer should have fired.
  await reapInFlightRuns(new Date(MINUTE.getTime() + (60 + 120 + 60) * 1000));

  const run = await oneRun("cron_1");
  assert.equal(run.status, "timedout");
  assert.deepEqual(agent.killed, ["agentjob_1"]);
});

test("history is pruned to the job's retention", async () => {
  await seedCronJob(db, { id: "cron_1", keepRuns: 10, overlap: "allow" });
  for (let i = 0; i < 14; i++) {
    await fireDueJobs([new Date(MINUTE.getTime() + i * 60_000)]);
    agent.settleAll({ exitCode: 0 });
    await reapInFlightRuns(new Date(MINUTE.getTime() + i * 60_000 + 30_000));
  }
  const runs = await runsOf(db, "cron_1");
  assert.equal(runs.length, 10);
  // The OLDEST are the ones that go.
  assert.ok(runs.every((r) => r.status === "succeeded"));
});

test("a bad timezone stops that job only", async () => {
  await seedCronJob(db, { id: "cron_ok" });
  await seedCronJob(db, { id: "cron_bad", name: "bad" });
  // Written by something that bypassed validation. It must not take the tick
  // down with it.
  await db
    .update(cronJobsTable)
    .set({ timezone: "Mars/Olympus" })
    .where(eq(cronJobsTable.id, "cron_bad"));

  await fireDueJobs([MINUTE]);
  assert.equal((await runsOf(db, "cron_ok")).length, 1);
  assert.equal((await runsOf(db, "cron_bad")).length, 0);
});

test("a too-old agent fails the attempt with an actionable message", async () => {
  const { AgentCronUnsupportedError } = await import("../infra/agent-client");
  agent.connectError = new AgentCronUnsupportedError("This server's agent is too old to run cron jobs.");
  await seedCronJob(db, { id: "cron_1" });
  await fireDueJobs([MINUTE]);

  const run = await oneRun("cron_1");
  assert.equal(run.status, "failed");
  assert.match(run.error ?? "", /too old/);
});

test("every agent connection is closed", async () => {
  await seedCronJob(db, { id: "cron_1" });
  await fireDueJobs([MINUTE]);
  await reapInFlightRuns(new Date(MINUTE.getTime() + 60_000));
  assert.equal(agent.closed, 2, "one per phase, and neither leaks");
});

test("the reaper heartbeat can stop a drain mid-flight", async () => {
  await seedCronJob(db, { id: "cron_1" });
  await fireDueJobs([MINUTE], async () => false);
  // The lease was stolen before the first job: racing the new owner is worse
  // than doing nothing this minute.
  assert.equal((await runsOf(db, "cron_1")).length, 0);
});

test("a manual run ignores overlap and is tagged as manual", async () => {
  const { loadSchedulableJob, runJobNow } = await import("./runner");
  await seedCronJob(db, { id: "cron_1", overlap: "skip" });
  await fireDueJobs([MINUTE]);

  const schedulable = await loadSchedulableJob("cron_1");
  assert.ok(schedulable);
  await runJobNow(schedulable, "Ada");

  const runs = await runsOf(db, "cron_1");
  assert.equal(runs.length, 2);
  const manual = runs.find((r) => r.trigger === "manual")!;
  assert.equal(manual.status, "running", "a button press is not skipped");
  assert.equal(manual.actor, "Ada");
});

test("cancelling settles the row even when the agent cannot be reached", async () => {
  const { cancelRun, loadInFlightRun } = await import("./runner");
  await seedCronJob(db, { id: "cron_1" });
  await fireDueJobs([MINUTE]);
  const run = await oneRun("cron_1");

  const inflight = await loadInFlightRun(run.id);
  assert.ok(inflight);
  agent.connectError = new AgentUnreachableError("host down");
  await cancelRun(inflight, "Ada");

  // Leaving it `running` would starve every later fire under overlap=skip.
  const after = (await db.select().from(cronRunsTable).where(eq(cronRunsTable.id, run.id)))[0];
  assert.equal(after.status, "failed");
  assert.match(after.error ?? "", /Stopped by Ada/);
});
