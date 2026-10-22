import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { makeTestDb, type TestDb } from "../../db/test-harness";
import { runWithIdentity } from "../../auth/request-context";
import { startMigrationRun } from "../migration-runner/start";
import { migrationRuns as runsTable } from "../../db/schema/control-plane/migration";
import { TEAM_B, USER_1 } from "../identity-test-helpers";
import { __setMigrationFetchForTest } from "../../migration/transport";
import { importMigrationProject } from "./project-import";
import { stopMigration } from "./revert";
import { beginMigration, finishMigration } from "./run-lifecycle";
import { getMigrationRun, listMigrationRuns } from "./run-queries";
import { renameProject } from "../projects/lifecycle";
import { startApp } from "../apps/lifecycle";
import { startDeployment } from "../../deploy/build/deploy-start";
import {
  URL_BASE,
  CONNECT,
  asOwner,
  importProject,
  openMigrationHarness,
  closeMigrationHarness,
  resetMigrationHarness,
} from "./migration-import-test-helpers";

let db: TestDb;
let pg: PGlite;

before(async () => {
  ({ db, pg } = await makeTestDb());
  await openMigrationHarness(db);
});

after(() => closeMigrationHarness(db, pg));

beforeEach(() => resetMigrationHarness(db));

test("what a running migration created is nobody else's to touch", async () => {
  const runId = await asOwner(() => beginMigration({ url: URL_BASE }));
  await importProject(runId, "dok-prj-blink");

  const rows = await db.execute(
    "select id, name, migration_run_id from apps order by name",
  );
  assert.ok(rows.rows.length > 0);
  for (const r of rows.rows)
    assert.equal(
      r.migration_run_id,
      runId,
      `${r.name} must be marked as the run's while it is still running`,
    );
  const projects = await db.execute("select migration_run_id from projects");
  assert.equal(projects.rows[0].migration_run_id, runId);

  const appId = String(rows.rows[0].id);
  await assert.rejects(
    () => asOwner(() => startApp(appId)),
    /still being brought over by a migration/,
  );
  await assert.rejects(
    () => asOwner(() => startDeployment(appId, { creator: "test" })),
    /still being brought over by a migration/,
  );
  await assert.rejects(
    () => asOwner(() => renameProject("prc_blink_missing", "x")),
    /not found|still being brought over/i,
  );
});

test("finishing the migration hands everything back", async () => {
  const runId = await asOwner(() => beginMigration({ url: URL_BASE }));
  await importProject(runId, "dok-prj-blink");
  await asOwner(() => finishMigration(runId));

  const rows = await db.execute("select migration_run_id from apps");
  for (const r of rows.rows) assert.equal(r.migration_run_id, null);
  const projects = await db.execute("select migration_run_id from projects");
  for (const r of projects.rows) assert.equal(r.migration_run_id, null);
  const envs = await db.execute("select migration_run_id from environments");
  for (const r of envs.rows) assert.equal(r.migration_run_id, null);
});

test("stopping it hands everything back too, and so does the next run", async () => {
  const first = await asOwner(() => beginMigration({ url: URL_BASE }));
  await importProject(first, "dok-prj-blink");
  await asOwner(() => stopMigration(first));
  let rows = await db.execute("select migration_run_id from apps");
  for (const r of rows.rows) assert.equal(r.migration_run_id, null);

  const second = await asOwner(() => beginMigration({ url: URL_BASE }));
  await importProject(second, "dok-prj-other");
  await asOwner(() => beginMigration({ url: URL_BASE }));
  rows = await db.execute(
    "select migration_run_id from apps where migration_run_id is not null",
  );
  assert.equal(rows.rows.length, 0);
});

test("the run keeps the report after the tab is gone", async () => {
  const runId = await asOwner(() =>
    beginMigration({ url: URL_BASE, orgName: "Acme Inc" }),
  );
  await importProject(runId, "dok-prj-blink");
  await asOwner(() => finishMigration(runId));

  const runs = await asOwner(() => listMigrationRuns());
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, "done");
  assert.equal(runs[0].orgName, "Acme Inc");
  assert.ok(runs[0].created > 0);
  assert.ok(runs[0].manual > 0, "the things needing a person are counted");
  assert.ok(runs[0].finishedAt);

  const full = await asOwner(() => getMigrationRun(runId));
  assert.equal(full!.items.length > 0, true);
  assert.ok(full!.items.some((i) => i.path.startsWith("Blink / production /")));
  assert.equal(JSON.stringify(full).includes(CONNECT.apiKey), false);
});

test("a run left open by a closed tab is closed as interrupted by the next one", async () => {
  const abandoned = await asOwner(() => beginMigration({ url: URL_BASE }));
  await asOwner(() => beginMigration({ url: URL_BASE }));

  const runs = await asOwner(() => listMigrationRuns());
  const old = runs.find((r) => r.id === abandoned)!;
  assert.equal(old.status, "failed");
  assert.match(old.error ?? "", /^Stopped answering/);
  assert.equal(runs.filter((r) => r.status === "running").length, 1);
});

test("an import run belongs to its team", async () => {
  const runId = await asOwner(() => beginMigration({ url: URL_BASE }));
  await assert.rejects(
    () =>
      runWithIdentity({ userId: USER_1, teamId: TEAM_B }, () =>
        importMigrationProject({
          ...CONNECT,
          runId,
          projectId: "dok-prj-blink",
        }),
      ),
    /scoped to a team the user no longer belongs to|does not belong to this team/,
  );
});

test("a machine with no agent stops the run before it starts", async () => {
  const before = (await db.select().from(runsTable)).length;
  await assert.rejects(
    () =>
      asOwner(() =>
        startMigrationRun({
          url: URL_BASE,
          apiKey: CONNECT.apiKey,
          orgName: null,
          targets: [
            {
              projectId: "dok-prj-blink",
              projectName: "Blink",
              serviceId: "dok-app-web",
              serverId: null,
              buildServerId: null,
              exposedPort: null,
              exposedPortSet: false,
            },
          ],
          servers: [],
        }),
      ),
    /has no agent[\s\S]*every machine has to answer/,
  );
  assert.equal((await db.select().from(runsTable)).length, before);
});

test("a panel that does not answer leaves no run behind", async () => {
  __setMigrationFetchForTest(async () => new Response("nope", { status: 502 }));
  const before = (await db.select().from(runsTable)).length;
  await assert.rejects(() =>
    asOwner(() =>
      startMigrationRun({
        url: URL_BASE,
        apiKey: "whatever",
        orgName: null,
        targets: [
          {
            projectId: "dok-prj-blink",
            projectName: "Blink",
            serviceId: "dok-app-web",
            serverId: null,
            buildServerId: null,
            exposedPort: null,
            exposedPortSet: false,
          },
        ],
        servers: [],
      }),
    ),
  );
  assert.equal(
    (await db.select().from(runsTable)).length,
    before,
    "nothing to stop, nothing to clean up",
  );
});

test("a run records the platform, and defaults to the older one", async () => {
  const runId = await asOwner(() => beginMigration({ url: URL_BASE }));
  const rows = await asOwner(() => listMigrationRuns());
  assert.equal(rows.find((r) => r.id === runId)?.platform, "dokploy");
});

test("a run opened as Coolify stays Coolify", async () => {
  const runId = await asOwner(() =>
    beginMigration({ url: URL_BASE, kind: "coolify" }),
  );
  const rows = await asOwner(() => listMigrationRuns());
  assert.equal(rows.find((r) => r.id === runId)?.platform, "coolify");
});

test("the platform is on the row, not derived from the address", async () => {
  await asOwner(() => beginMigration({ url: URL_BASE, kind: "coolify" }));
  const [row] = (
    await db.execute(
      "select platform from migration_runs order by seq desc limit 1",
    )
  ).rows as { platform: string }[];
  assert.equal(row.platform, "coolify");
});
