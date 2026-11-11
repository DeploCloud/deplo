import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { eq } from "drizzle-orm";

import { fireDueJobs } from "../crons/runner/fire";
import {
  __setQuickFinishPolls,
  reapInFlightRuns,
} from "../crons/runner/attempt";
import { cronJobs as cronJobsTable } from "../db/schema/control-plane/crons";
import { __settleAlertsForTest } from "../notify/dispatch";
import { captureFetch } from "../notify/fetch-capture-test-helpers";
import { runWithIdentity } from "../auth/request-context";
import { cancelCronRun, runCronJobNow } from "./crons/runs";
import { TEAM_B } from "./identity-test-helpers";
import { saveNotificationChannel } from "./notifications";
import { failoverLab } from "./cluster-failover-test-helpers";
import {
  enableCrons,
  FakeAgent,
  runsOf,
  seedCronJob,
} from "./cron-test-helpers";

const lab = failoverLab();
const { asAdmin, eu, web, event, apply } = lab;

const MINUTE = new Date("2026-07-15T01:00:00.000Z");
const NEXT_MINUTE = new Date("2026-07-15T01:01:00.000Z");

let jobs: Record<string, FakeAgent>;

beforeEach(() => {
  __setQuickFinishPolls([]);
  jobs = {};
  for (const id of ["srv_2", "srv_3"]) {
    const agent = new FakeAgent();
    lab.members[id].extra = agent.connection();
    lab.members[id].capabilities.push("cron");
    jobs[id] = agent;
  }
});

afterEach(() => __setQuickFinishPolls([150, 250, 350, 500]));

/** The App `web` on cluster eu, running on srv_2, with one job due every minute. */
async function webWithJob(over: { maxAttempts?: number } = {}) {
  const cluster = await eu();
  lab.seq = 0;
  await web(cluster.id);
  await enableCrons(lab.db, "app", "prj_web");
  await seedCronJob(lab.db, {
    id: "cron_1",
    appId: "prj_web",
    name: "nightly",
    overlap: "allow",
    ...over,
  });
  return cluster;
}

const movedTo = (clusterId: string, member: string) =>
  event(clusterId, "placement", {
    kind: "app",
    workloadId: "prj_web",
    members: [member],
    epoch: 1,
  });

test("a cluster App's job fires once, on the member running the App now", async () => {
  const cluster = await webWithJob();

  await fireDueJobs([MINUTE]);
  assert.equal(jobs.srv_2.started.length, 1);
  assert.equal(jobs.srv_3.started.length, 0);

  await apply(cluster.id, movedTo(cluster.id, "srv_3"));
  await fireDueJobs([NEXT_MINUTE]);
  assert.equal(jobs.srv_2.started.length, 1, "nothing more on the old member");
  assert.equal(jobs.srv_3.started.length, 1);
  assert.equal((await runsOf(lab.db, "cron_1")).length, 2);
});

const after = (ms: number) => new Date(MINUTE.getTime() + ms);

const stopped = (clusterId: string, member: string) =>
  event(clusterId, "member_state", { member, state: "fenced" });

async function hearAbout(alert: "cron_run_lost") {
  await asAdmin(() =>
    saveNotificationChannel(null, {
      kind: "webhook",
      name: "",
      enabled: true,
      url: "https://ops/hook",
      target: "",
      emailFrom: "",
      emailProvider: "resend",
      smtpHost: "",
      smtpPort: 587,
      smtpUser: "",
      alerts: [alert],
    }),
  );
  lab.capture = captureFetch();
  return lab.capture;
}

test("a run in flight on a member that stopped is marked lost, alerts once and is never retried", async () => {
  const cluster = await webWithJob({ maxAttempts: 3 });
  const hook = await hearAbout("cron_run_lost");
  await fireDueJobs([MINUTE]);

  lab.members.srv_2.unreachable = true;
  await apply(cluster.id, stopped(cluster.id, "srv_2"));
  await reapInFlightRuns(after(70_000));

  const [run] = await runsOf(lab.db, "cron_1");
  assert.equal(run.status, "server_lost");
  assert.equal(run.error, "server-2 stopped while this run was in flight.");
  assert.equal(run.finishedAt, after(70_000).toISOString());
  const [job] = await lab.db
    .select()
    .from(cronJobsTable)
    .where(eq(cronJobsTable.id, "cron_1"));
  assert.equal(job.lastStatus, "server_lost");

  // Later reaps, with the member back or not, start nothing and say nothing more.
  await reapInFlightRuns(after(140_000));
  lab.members.srv_2.unreachable = false;
  await reapInFlightRuns(after(600_000));
  await __settleAlertsForTest();
  const runs = await runsOf(lab.db, "cron_1");
  assert.equal(runs.length, 1);
  assert.equal(runs[0].attempt, 0);
  assert.equal(runs[0].status, "server_lost");
  assert.equal(jobs.srv_2.started.length, 1);
  assert.equal(jobs.srv_3.started.length, 0);
  assert.equal(hook.calls.length, 1);
  const sent = hook.calls[0].body as { title?: string; body?: string };
  assert.equal(sent.title, 'Cron job "nightly" was lost: its server stopped');
  assert.match(String(sent.body), /Deplo does not run it again on its own/);
});

test("a run whose App failed over is judged on the member it started on, and Run now starts a new one on the current member", async () => {
  const cluster = await webWithJob();
  await fireDueJobs([MINUTE]);

  // The leader moved the App before the scheduler looked again: the new member never ran this job.
  lab.members.srv_2.unreachable = true;
  await apply(
    cluster.id,
    stopped(cluster.id, "srv_2"),
    movedTo(cluster.id, "srv_3"),
  );
  await reapInFlightRuns(after(90_000));
  const [lost] = await runsOf(lab.db, "cron_1");
  assert.equal(lost.status, "server_lost");
  assert.equal(jobs.srv_3.started.length, 0, "never retried on its own");

  await assert.rejects(
    runWithIdentity({ userId: "user_b", teamId: TEAM_B }, () =>
      runCronJobNow("cron_1"),
    ),
    /not found/i,
  );
  const again = await asAdmin(() => runCronJobNow("cron_1"));
  assert.equal(again.status, "running");
  assert.equal(again.trigger, "manual");
  assert.equal(jobs.srv_3.started.length, 1);
  assert.equal(jobs.srv_2.started.length, 1);
  const runs = await runsOf(lab.db, "cron_1");
  assert.deepEqual(
    runs.map((r) => [r.status, r.serverId]),
    [
      ["server_lost", "srv_2"],
      ["running", "srv_3"],
    ],
  );
});

test("a job its member stopped itself when the lease ran out is lost, not failed, and not retried", async () => {
  await webWithJob({ maxAttempts: 3 });
  await fireDueJobs([MINUTE]);

  // Cut off from its leader but not from Deplo: the server agent answers, and says it stopped the job.
  jobs.srv_2.settleAll({ exitCode: -1, stderr: "stopped", fenced: true });
  await reapInFlightRuns(after(65_000));
  await reapInFlightRuns(after(200_000));

  const runs = await runsOf(lab.db, "cron_1");
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, "server_lost");
  assert.equal(runs[0].attempt, 0);
  assert.equal(jobs.srv_2.started.length, 1);
});

test("a member that answers decides for itself: a stale 'stopped' never marks a run lost while it runs or after it finished", async () => {
  const cluster = await webWithJob();
  await fireDueJobs([MINUTE]);
  // The lease was renewed, but the event saying so has not been applied yet.
  await apply(cluster.id, stopped(cluster.id, "srv_2"));

  await reapInFlightRuns(after(70_000));
  assert.equal((await runsOf(lab.db, "cron_1"))[0].status, "running");

  jobs.srv_2.settleAll({ exitCode: 0, stdout: "done" });
  await reapInFlightRuns(after(90_000));
  const [run] = await runsOf(lab.db, "cron_1");
  assert.equal(run.status, "succeeded");
  assert.equal(run.stdout, "done");
});

test("a run on a healthy member is left alone when another member stops", async () => {
  const cluster = await webWithJob();
  await fireDueJobs([MINUTE]);
  await apply(cluster.id, stopped(cluster.id, "srv_3"));
  await reapInFlightRuns(after(70_000));
  assert.equal((await runsOf(lab.db, "cron_1"))[0].status, "running");
});

test("a run whose App moved off a healthy member is still watched, and stopped, where it started", async () => {
  const cluster = await webWithJob();
  await fireDueJobs([MINUTE]);
  await fireDueJobs([NEXT_MINUTE]);
  await apply(cluster.id, movedTo(cluster.id, "srv_3"));
  const [first, second] = await runsOf(lab.db, "cron_1");

  await asAdmin(() => cancelCronRun(second.id));
  assert.deepEqual(jobs.srv_2.killed, [second.agentJobId]);
  assert.deepEqual(jobs.srv_3.killed, []);

  jobs.srv_2.settleAll({ exitCode: 0, stdout: "done" });
  await reapInFlightRuns(after(120_000));
  const [finished] = await runsOf(lab.db, "cron_1");
  assert.equal(finished.id, first.id);
  assert.equal(finished.status, "succeeded");
  assert.equal(finished.stdout, "done");
});
