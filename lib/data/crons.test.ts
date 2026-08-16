import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import {
  cronJobEnv,
  cronJobs as cronJobsTable,
  cronRuns as cronRunsTable,
} from "../db/schema/control-plane";
import { runWithIdentity } from "../auth/request-context";
import { seedIdentity, TEAM_A, TEAM_B, USER_1 } from "./identity-test-helpers";
import { seedApp, seedServer } from "./app-graph-test-helpers";
import { seedDatabase, TRUNCATE_BACKUPS } from "./backup-test-helpers";
import {
  enableCrons,
  seedCronJob,
  seedCronRun,
  TRUNCATE_CRONS,
} from "./cron-test-helpers";
import * as crons from "./crons";

/**
 * The GATES and the VALIDATION - the half of the feature that is a security
 * boundary rather than a scheduler. The mechanics are covered in
 * lib/crons/scheduler.test.ts against a fake agent; nothing here reaches a host.
 */

/** The other team's owner. `identity-test-helpers` only exports USER_1. */
const USER_2 = "user_2";

let db: TestDb;
let pg: PGlite;

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
});

after(async () => {
  __resetTestDb();
  await pg.close();
});

beforeEach(async () => {
  await pg.exec(`${TRUNCATE_CRONS} ${TRUNCATE_BACKUPS}
    truncate table app_build_method_settings, app_build, apps, servers,
      membership_capabilities, memberships, users, teams restart identity cascade;`);
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      { id: USER_2, teamId: TEAM_B, role: "owner" },
    ],
  });
  await seedServer(db);
  await seedApp(db, { id: "prj_1", slug: "web" });
  await seedDatabase(db, { id: "db_1", name: "main" });
  await enableCrons(db, "app", "prj_1");
});

const asOwner = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);

const asOtherTeam = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: USER_2, teamId: TEAM_B }, fn);

const validJob = {
  name: "Nightly invoices",
  schedule: "0 3 * * *",
  command: "php artisan invoices:send",
};

/* ---- Gates ------------------------------------------------------- */

test("another team cannot read or write this team's cron jobs", async () => {
  const id = await asOwner(async () => (await crons.createCronJob("app", "prj_1", validJob)).id);

  // An app id from another team must read as "not found", never as "denied" -
  // the gate is not an oracle for which ids exist.
  await assert.rejects(
    () => asOtherTeam(() => crons.listAppCronJobs("prj_1")),
    /not found/i,
  );
  await assert.rejects(
    () => asOtherTeam(() => crons.updateCronJob(id, { command: "curl evil.example" })),
    /not found/i,
  );
  await assert.rejects(() => asOtherTeam(() => crons.deleteCronJob(id)), /not found/i);
  await assert.rejects(() => asOtherTeam(() => crons.listCronRuns(id)), /not found/i);
});

test("a database job needs database-console access as well", async () => {
  // `manage_crons` is seeded from EITHER console capability, so app-console
  // access alone must not reach inside a database. Strip the database one.
  await db.execute(
    `delete from membership_capabilities where capability = 'open_database_console'`,
  );
  await assert.rejects(
    () => asOwner(() => crons.createCronJob("database", "db_1", validJob)),
    /permission/i,
  );
  // The app side still works with exactly the same set.
  await asOwner(() => crons.createCronJob("app", "prj_1", validJob));
});

test("without manage_crons nothing is readable or writable", async () => {
  await db.execute(`delete from membership_capabilities where capability = 'manage_crons'`);
  await assert.rejects(() => asOwner(() => crons.listAppCronJobs("prj_1")), /permission|not found/i);
  await assert.rejects(
    () => asOwner(() => crons.createCronJob("app", "prj_1", validJob)),
    /permission|not found/i,
  );
});

/* ---- Validation -------------------------------------------------- */

test("an unparseable schedule is refused, not stored", async () => {
  // The scheduler treats an unparseable cron as "never matches", so storing one
  // would leave a job the UI calls enabled that silently never runs.
  await assert.rejects(
    () => asOwner(() => crons.createCronJob("app", "prj_1", { ...validJob, schedule: "every night" })),
    /not a valid cron expression/,
  );
  assert.equal((await db.select().from(cronJobsTable)).length, 0);
});

test("a timezone is validated against Intl, not trusted", async () => {
  await assert.rejects(
    () => asOwner(() => crons.createCronJob("app", "prj_1", { ...validJob, timezone: "Mars/Olympus" })),
    /is not a timezone/,
  );
  const job = await asOwner(() =>
    crons.createCronJob("app", "prj_1", { ...validJob, timezone: "  Europe/Rome  " }),
  );
  assert.equal(job.timezone, "Europe/Rome");
});

test("name and command are required and trimmed", async () => {
  await assert.rejects(
    () => asOwner(() => crons.createCronJob("app", "prj_1", { ...validJob, name: "   " })),
    /Give the cron job a name/,
  );
  await assert.rejects(
    () => asOwner(() => crons.createCronJob("app", "prj_1", { ...validJob, command: "" })),
    /a command to run/,
  );
});

test("two jobs on one app cannot share a name", async () => {
  await asOwner(() => crons.createCronJob("app", "prj_1", validJob));
  await assert.rejects(
    () => asOwner(() => crons.createCronJob("app", "prj_1", validJob)),
    /already exists/,
  );
});

test("timeout x attempts is clamped to 24 hours", async () => {
  // 24h x 4 attempts would hold the job's `running` slot for four days and, under
  // overlap=skip, starve every later fire.
  await assert.rejects(
    () =>
      asOwner(() =>
        crons.createCronJob("app", "prj_1", {
          ...validJob,
          timeoutSeconds: 24 * 3600,
          maxAttempts: 4,
        }),
      ),
    /Lower the timeout or the retries/,
  );
  // Each on its own is fine.
  await asOwner(() =>
    crons.createCronJob("app", "prj_1", { ...validJob, timeoutSeconds: 24 * 3600 }),
  );
});

test("the clamp reads the STORED value when only one side is edited", async () => {
  const job = await asOwner(() =>
    crons.createCronJob("app", "prj_1", { ...validJob, timeoutSeconds: 12 * 3600 }),
  );
  // 12h is fine alone; asking for 3 attempts of it is 36 hours.
  await assert.rejects(
    () => asOwner(() => crons.updateCronJob(job.id, { maxAttempts: 3 })),
    /Lower the timeout or the retries/,
  );
  await asOwner(() => crons.updateCronJob(job.id, { maxAttempts: 2 }));
});

test("retention, attempts and shell are bounded", async () => {
  const bad: [Parameters<typeof crons.createCronJob>[2], RegExp][] = [
    [{ ...validJob, keepRuns: 5 }, /between 10 and 500/],
    [{ ...validJob, keepRuns: 5000 }, /between 10 and 500/],
    [{ ...validJob, maxAttempts: 9 }, /between 1 and 4/],
    [{ ...validJob, shell: "zsh" }, /sh or bash/],
    [{ ...validJob, overlap: "queue" }, /skip or allow/],
    [{ ...validJob, timeoutSeconds: 0 }, /between 1 second and 24 hours/],
  ];
  for (const [input, message] of bad) {
    await assert.rejects(() => asOwner(() => crons.createCronJob("app", "prj_1", input)), message);
  }
});

/* ---- Secrets ----------------------------------------------------- */

test("job variables are encrypted and have no read path", async () => {
  const job = await asOwner(() =>
    crons.createCronJob("app", "prj_1", {
      ...validJob,
      env: [{ key: "API_KEY", value: "s3cr3t" }],
    }),
  );
  // The DTO carries the NAME and never the value.
  assert.deepEqual(job.envKeys, ["API_KEY"]);
  assert.equal(JSON.stringify(job).includes("s3cr3t"), false);

  // And what is at rest is ciphertext.
  const rows = await db.select().from(cronJobEnv).where(eq(cronJobEnv.jobId, job.id));
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0].valueEnc, "s3cr3t");
});

test("a variable name must be a variable name", async () => {
  await assert.rejects(
    () =>
      asOwner(() =>
        crons.createCronJob("app", "prj_1", {
          ...validJob,
          env: [{ key: "API KEY; rm -rf /", value: "x" }],
        }),
      ),
    /not a valid variable name/,
  );
});

test("editing the environment replaces it wholesale", async () => {
  const job = await asOwner(() =>
    crons.createCronJob("app", "prj_1", {
      ...validJob,
      env: [
        { key: "A", value: "1" },
        { key: "B", value: "2" },
      ],
    }),
  );
  const updated = await asOwner(() =>
    crons.updateCronJob(job.id, { env: [{ key: "C", value: "3" }] }),
  );
  assert.deepEqual(updated.envKeys, ["C"]);
  assert.equal(
    (await db.select().from(cronJobEnv).where(eq(cronJobEnv.jobId, job.id))).length,
    1,
  );
});

/* ---- Reads ------------------------------------------------------- */

test("the view carries the master switch and the pickable services", async () => {
  await asOwner(() => crons.createCronJob("app", "prj_1", validJob));
  const view = await asOwner(() => crons.listAppCronJobs("prj_1"));
  assert.equal(view.enabled, true);
  assert.equal(view.targetKind, "app");
  assert.equal(view.jobs.length, 1);
  // A single-image app offers its own slug as the one container.
  assert.deepEqual(view.services, ["web"]);
});

test("nextRunAt is computed in the job's zone, and only while enabled", async () => {
  const job = await asOwner(() =>
    crons.createCronJob("app", "prj_1", {
      ...validJob,
      schedule: "0 3 * * *",
      timezone: "Europe/Rome",
    }),
  );
  assert.ok(job.nextRunAt, "an enabled job says when it runs next");
  // 03:00 Rome is never 03:00Z - that is the whole point of storing the zone.
  assert.equal(new Date(job.nextRunAt!).getUTCHours() === 3, false);

  const off = await asOwner(() => crons.updateCronJob(job.id, { enabled: false }));
  assert.equal(off.nextRunAt, null);
});

test("the master switch is per target and leaves the jobs alone", async () => {
  const job = await asOwner(() => crons.createCronJob("app", "prj_1", validJob));
  await asOwner(() => crons.setCronEnabled("app", "prj_1", false));

  const view = await asOwner(() => crons.listAppCronJobs("prj_1"));
  assert.equal(view.enabled, false);
  assert.equal(view.jobs.length, 1, "the jobs survive the switch");
  assert.equal(view.jobs[0].enabled, true, "and keep their own state");
  assert.equal(view.jobs[0].id, job.id);
});

test("a deleted job takes its history with it", async () => {
  await seedCronJob(db, { id: "cron_x", appId: "prj_1", name: "seeded" });
  await asOwner(() => crons.deleteCronJob("cron_x"));
  assert.equal((await db.select().from(cronJobsTable)).length, 0);
});

test("a job says whether a run is in flight right now", async () => {
  const job = await asOwner(() => crons.createCronJob("app", "prj_1", validJob));
  assert.equal(
    (await asOwner(() => crons.listAppCronJobs("prj_1"))).jobs[0].running,
    false,
  );

  await seedCronRun(db, { id: "cronrun_1", jobId: job.id });
  const view = await asOwner(() => crons.listAppCronJobs("prj_1"));
  // `lastStatus` cannot answer this - it is written when a run SETTLES, so it
  // never says `running` and a job mid-flight still reads as its last outcome.
  assert.equal(view.jobs[0].running, true);
  assert.equal(view.jobs[0].lastStatus, null);

  await db
    .update(cronRunsTable)
    .set({ status: "succeeded" })
    .where(eq(cronRunsTable.id, "cronrun_1"));
  assert.equal(
    (await asOwner(() => crons.listAppCronJobs("prj_1"))).jobs[0].running,
    false,
  );
});

test("Run now answers with a skipped run while one is in flight", async () => {
  // The setting says "if it is still running, skip this run" - a button press is
  // not the one caller allowed to start a second copy. Nothing reaches a host:
  // the overlap rule is decided in the store, before any agent is dialled.
  const job = await asOwner(() =>
    crons.createCronJob("app", "prj_1", { ...validJob, overlap: "skip" }),
  );
  await seedCronRun(db, { id: "cronrun_1", jobId: job.id });

  const run = await asOwner(() => crons.runCronJobNow(job.id));
  assert.equal(run.status, "skipped");
  assert.equal(run.trigger, "manual");
  assert.match(run.error ?? "", /still in progress/);

  const runs = await asOwner(() => crons.listCronRuns(job.id));
  assert.equal(runs.length, 2, "and it is in the history, saying why");
  assert.equal(runs.filter((r) => r.status === "running").length, 1);
});

test("Run now refuses while the master switch is off", async () => {
  // The page is hidden when the switch is off, so the API must not be the one
  // way around the opt-in.
  const job = await asOwner(() => crons.createCronJob("app", "prj_1", validJob));
  await asOwner(() => crons.setCronEnabled("app", "prj_1", false));
  await assert.rejects(
    () => asOwner(() => crons.runCronJobNow(job.id)),
    /switched off/,
  );
});
