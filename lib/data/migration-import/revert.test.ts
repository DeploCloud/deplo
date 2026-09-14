import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { makeTestDb, type TestDb } from "../../db/test-harness";
import { eq } from "drizzle-orm";
import { runWithIdentity } from "../../auth/request-context";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import { sharedEnvVars as sharedVarsTable } from "../../db/schema/control-plane/env-vars";
import { migrationRuns as runsTable } from "../../db/schema/control-plane/migration";
import { projects as projectsTable } from "../../db/schema/control-plane/projects";
import { servers as serversTable } from "../../db/schema/control-plane/servers";
import { TEAM_A, TEAM_B, USER_1 } from "../identity-test-helpers";
import { seedApp, seedServer } from "../app-graph-test-helpers";
import { settleProvisioning } from "../backup-test-helpers";
import { revertMigration, stopMigration } from "./revert";
import { beginMigration } from "./run-lifecycle";
import { getMigrationRun } from "./run-queries";
import { createProject } from "../projects/lifecycle";
import {
  URL_BASE,
  USER_2,
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

test("a revert removes what the run created", async () => {
  const runId = await asOwner(() => beginMigration({ url: URL_BASE }));
  await importProject(runId, "dok-prj-blink");
  await settleProvisioning(db);
  assert.ok(
    (await db.select().from(appsTable)).length > 0,
    "nothing was imported",
  );

  const result = await asOwner(() => revertMigration(runId));
  await settleProvisioning(db);

  assert.ok(result.apps > 0, `removed ${result.apps} apps`);
  assert.equal(result.projects, 1, "the project it created is gone too");
  assert.deepEqual(result.failed, []);
  assert.equal((await db.select().from(appsTable)).length, 0);
  assert.equal((await db.select().from(projectsTable)).length, 0);
  assert.equal((await db.select().from(sharedVarsTable)).length, 0);

  const rows = await db.select().from(runsTable).where(eq(runsTable.id, runId));
  assert.equal(rows[0].status, "reverted");
});

test("what a revert could not remove is written into the run's log", async () => {
  const runId = await asOwner(() => beginMigration({ url: URL_BASE }));
  await importProject(runId, "dok-prj-blink");
  await settleProvisioning(db);

  const result = await runWithIdentity({ userId: USER_2, teamId: TEAM_A }, () =>
    revertMigration(runId),
  );
  await settleProvisioning(db);

  assert.ok(
    result.failed.length > 0,
    "nothing failed, so this fixture proves nothing",
  );
  assert.equal(
    result.apps,
    0,
    "an app went out under a capability that bars it",
  );

  const report = await asOwner(() => getMigrationRun(runId));
  const leftovers = report!.items.filter((i) => i.sourceKind === "undo");
  assert.equal(leftovers.length, result.failed.length);
  assert.ok(
    leftovers.every((i) => i.outcome === "failed" && i.message),
    "a leftover with no reason is not a log line",
  );
});

test("a revert never touches a project the run only reused", async () => {
  const mine = await asOwner(() => createProject("Blink"));
  await seedApp(db, { id: "prj_keep", projectId: mine.id });

  const runId = await asOwner(() => beginMigration({ url: URL_BASE }));
  await importProject(runId, "dok-prj-blink");
  await settleProvisioning(db);

  const result = await asOwner(() => revertMigration(runId));
  await settleProvisioning(db);

  assert.equal(result.projects, 0, "it deleted a project it did not create");
  const projects = await db.select().from(projectsTable);
  assert.deepEqual(
    projects.map((p) => p.id),
    [mine.id],
  );
  const apps = await db.select().from(appsTable);
  assert.deepEqual(
    apps.map((a) => a.id),
    ["prj_keep"],
  );
});

test("a revert of somebody else's run is not found", async () => {
  const runId = await asOwner(() => beginMigration({ url: URL_BASE }));
  await importProject(runId, "dok-prj-blink");
  await settleProvisioning(db);

  await assert.rejects(
    () =>
      runWithIdentity({ userId: USER_1, teamId: TEAM_B }, () =>
        revertMigration(runId),
      ),
    /no longer belongs|not found|permission/i,
  );
  assert.ok((await db.select().from(appsTable)).length > 0);
});

test("stopping a run undoes it whole: what it made here, and the agent over there", async () => {
  const SOURCE = "srv_stop_source";
  await seedServer(db, SOURCE);
  await db
    .update(serversTable)
    .set({ importOnly: true })
    .where(eq(serversTable.id, SOURCE));

  const runId = await asOwner(() => beginMigration({ url: URL_BASE }));
  await importProject(runId, "dok-prj-blink");
  await settleProvisioning(db);
  const landed = await db.select().from(appsTable);
  assert.ok(landed.length > 0, "the import has to have made something to undo");

  await asOwner(() => stopMigration(runId));

  const rows = await db.select().from(runsTable).where(eq(runsTable.id, runId));
  assert.equal(rows[0].status, "reverted");
  assert.equal(
    (await db.select().from(appsTable)).length,
    0,
    "everything the run created has to be gone",
  );
  const [source] = await db
    .select()
    .from(serversTable)
    .where(eq(serversTable.id, SOURCE));
  assert.ok(
    !source || source.uninstallNextAt !== null || source.uninstallError,
    "the agent Deplo put on the source is on its way back off",
  );

  await asOwner(() => stopMigration(runId));
  const again = await db
    .select()
    .from(runsTable)
    .where(eq(runsTable.id, runId));
  assert.equal(again[0].status, "reverted");
});
