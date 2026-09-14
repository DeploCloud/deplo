import {
  asOwner,
  CONNECT,
  closeHarness,
  openHarness,
  openRun,
  resetHarness,
  seedMigrationHostServer,
  state,
} from "./migration-data-test-helpers";

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { TestDb } from "../../db/test-harness";
import { startDeployment } from "../../deploy/build/deploy-start";
import { acceptDataCopyLoss } from "../data-copy";
import { startApp } from "../apps/lifecycle";
import { finishMigration } from "../migration-import/run-lifecycle";
import { moveMigrationServiceData } from "./move";

let db: TestDb;

before(async () => {
  db = await openHarness();
});

after(closeHarness);

beforeEach(resetHarness);

test("a copy that fails marks the app, and the marker holds the deploy", async () => {
  await seedMigrationHostServer();
  state.importRefusal = "no space left on device";
  const runId = await openRun();

  const res = await asOwner(() =>
    moveMigrationServiceData({
      ...CONNECT,
      runId,
      sourceKind: "application",
      sourceId: "dok-app-web",
    }),
  );
  assert.ok(res.failed > 0, "the copy must be reported as failed");

  const rows = await db.execute(
    "select data_copy_error from apps where id = 'prj_web'",
  );
  assert.match(String(rows.rows[0].data_copy_error), /no space left on device/);

  await asOwner(() => finishMigration(runId));

  await assert.rejects(
    () => asOwner(() => startDeployment("prj_web", { creator: "test" })),
    /did not come across/,
  );
  await assert.rejects(
    () => asOwner(() => startApp("prj_web")),
    /did not come across/,
  );
});

test("a copy that works clears a marker an earlier attempt left", async () => {
  await seedMigrationHostServer();
  state.importRefusal = "the stream was truncated";
  const runId = await openRun();
  await asOwner(() =>
    moveMigrationServiceData({
      ...CONNECT,
      runId,
      sourceKind: "application",
      sourceId: "dok-app-web",
    }),
  );

  state.importRefusal = "";
  const res = await asOwner(() =>
    moveMigrationServiceData({
      ...CONNECT,
      runId,
      sourceKind: "application",
      sourceId: "dok-app-web",
    }),
  );
  assert.equal(res.failed, 0);
  const rows = await db.execute(
    "select data_copy_error from apps where id = 'prj_web'",
  );
  assert.equal(rows.rows[0].data_copy_error, "");
});

test("accepting the loss unblocks the app, and says so in the trail", async () => {
  await seedMigrationHostServer();
  state.importRefusal = "the source host is gone";
  const runId = await openRun();
  await asOwner(() =>
    moveMigrationServiceData({
      ...CONNECT,
      runId,
      sourceKind: "application",
      sourceId: "dok-app-web",
    }),
  );

  await asOwner(() => finishMigration(runId));
  await asOwner(() => acceptDataCopyLoss({ kind: "app", id: "prj_web" }));

  const rows = await db.execute(
    "select data_copy_error from apps where id = 'prj_web'",
  );
  assert.equal(rows.rows[0].data_copy_error, "");
  const trail = await db.execute(
    "select message from activities where message like '%without the data%'",
  );
  assert.equal(trail.rows.length, 1);
});

// For a service RUNNING over there, "never started" is a claim about the source Deplo never
// checked - the app came up on empty storage with nothing holding it back.
test("a volume missing from a RUNNING service holds the deploy", async () => {
  await seedMigrationHostServer();
  state.notFoundVolumes.add("blink-web-abc_uploads");
  state.sourceRunning = true;
  state.startRefusesNoContainer = false;
  const runId = await openRun();

  await asOwner(() =>
    moveMigrationServiceData({
      ...CONNECT,
      runId,
      sourceKind: "application",
      sourceId: "dok-app-web",
    }),
  );

  const rows = await db.execute(
    `select message from migration_run_items where run_id = '${runId}' and source_name = 'blink-web-abc_uploads'`,
  );
  assert.match(
    String(rows.rows[0].message),
    /is running, so its data is on a different machine/,
  );
  const app = await db.execute(
    "select data_copy_error from apps where id = 'prj_web'",
  );
  assert.match(String(app.rows[0].data_copy_error), /not on the machine/);
});
