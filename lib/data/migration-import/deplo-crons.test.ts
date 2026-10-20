import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { makeTestDb, type TestDb } from "../../db/test-harness";
import { decryptSecret } from "../../crypto";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import { cronJobEnv, cronJobs } from "../../db/schema/control-plane/crons";
import { databases as databasesTable } from "../../db/schema/control-plane/databases";
import type { DeploExportCron } from "../../migration/deplo/export-shape";
import {
  deploExport,
  exportApp,
  exportDatabase,
} from "../../migration/deplo/deplo-test-helpers";
import {
  closeMigrationHarness,
  openMigrationHarness,
  provisionServer1,
  resetMigrationHarness,
} from "./migration-import-test-helpers";
import {
  blockingLines,
  importFromDeplo,
  reportLines,
} from "./deplo-import-test-helpers";

let db: TestDb;
let pg: PGlite;

before(async () => {
  ({ db, pg } = await makeTestDb());
  await openMigrationHarness(db);
});

after(() => closeMigrationHarness(db, pg));

beforeEach(async () => {
  await resetMigrationHarness(db);
  await provisionServer1(db);
});

const SECRET = "tok-9f8e7d";

const job = (over: Partial<DeploExportCron> = {}): DeploExportCron => ({
  name: "vacuum",
  schedule: "0 3 * * *",
  command: "vacuumdb --all",
  service: null,
  enabled: true,
  ...over,
});

async function landedJobs() {
  const jobs = await db.select().from(cronJobs);
  const env = await db.select().from(cronJobEnv);
  return jobs.map((j) => ({
    ...j,
    env: Object.fromEntries(
      env
        .filter((e) => e.jobId === j.id)
        .map((e) => [e.key, decryptSecret(e.valueEnc)]),
    ),
  }));
}

test("a database's cron job lands on the new database with its variables", async () => {
  const runId = await importFromDeplo(
    deploExport({
      apps: [],
      databases: [
        exportDatabase({
          cronEnabled: true,
          crons: [job({ env: [{ key: "PGTOKEN", value: SECRET }] })],
        }),
      ],
    }),
    ["prc_shop"],
  );
  const [main] = await db.select().from(databasesTable);
  const [vacuum] = await landedJobs();
  assert.equal(vacuum?.databaseId, main.id);
  assert.equal(vacuum.schedule, "0 3 * * *");
  assert.equal(vacuum.command, "vacuumdb --all");
  assert.deepEqual(vacuum.env, { PGTOKEN: SECRET });
  assert.equal(main.cronEnabled, true);
  const lines = (await reportLines(runId)).join("\n");
  assert.doesNotMatch(lines, /did not come across/);
  assert.ok(
    !lines.includes(SECRET),
    "a variable's value stays out of the report",
  );
});

test("an app's cron job keeps every setting, and its jobs stay switched on", async () => {
  await importFromDeplo(
    deploExport({
      apps: [
        exportApp({
          cronEnabled: true,
          crons: [
            job({
              name: "report",
              enabled: false,
              description: "weekly report",
              timezone: "Europe/Rome",
              shell: "bash",
              timeoutSeconds: 600,
              maxAttempts: 3,
              overlap: "allow",
              keepRuns: 20,
              workdir: "/srv",
              user: "app",
              env: [{ key: "MODE", value: "full" }],
            }),
          ],
        }),
      ],
      databases: [],
    }),
    ["prc_shop"],
  );
  const [web] = await db.select().from(appsTable);
  const [report] = await landedJobs();
  assert.equal(report?.appId, web.id);
  assert.equal(web.cronEnabled, true);
  assert.deepEqual(
    {
      enabled: report.enabled,
      description: report.description,
      timezone: report.timezone,
      shell: report.shell,
      timeoutSeconds: report.timeoutSeconds,
      maxAttempts: report.maxAttempts,
      overlap: report.overlap,
      keepRuns: report.keepRuns,
      workdir: report.workdir,
      user: report.user,
      env: report.env,
    },
    {
      enabled: false,
      description: "weekly report",
      timezone: "Europe/Rome",
      shell: "bash",
      timeoutSeconds: 600,
      maxAttempts: 3,
      overlap: "allow",
      keepRuns: 20,
      workdir: "/srv",
      user: "app",
      env: { MODE: "full" },
    },
  );
});

test("a job from an older Deplo lands with its schedule and says the rest did not", async () => {
  const runId = await importFromDeplo(
    deploExport({
      apps: [],
      databases: [exportDatabase({ crons: [job()] })],
    }),
    ["prc_shop"],
  );
  const [main] = await db.select().from(databasesTable);
  const [vacuum] = await landedJobs();
  assert.equal(vacuum?.command, "vacuumdb --all");
  assert.equal(main.cronEnabled, false);
  assert.match(
    (await reportLines(runId)).join("\n"),
    /too old to hand over the variables and settings of cron job\(s\) vacuum/,
  );
  assert.deepEqual(await blockingLines(runId), [], "the database runs anyway");
});
