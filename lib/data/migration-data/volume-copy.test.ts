import {
  asOwner,
  CONNECT,
  closeHarness,
  openHarness,
  openRun,
  resetHarness,
  seedMigrationHostServer,
  state,
  UPLOADS,
} from "./migration-data-test-helpers";

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { TestDb } from "../../db/test-harness";
import { SERVER_1 } from "../app-graph-test-helpers";
import { moveMigrationServiceData } from "./move";
import { planMigrationDataMove } from "./plan";

let db: TestDb;

before(async () => {
  db = await openHarness();
});

after(closeHarness);

beforeEach(resetHarness);

test("the copy reads the source host, and the bytes land in the target volume", async () => {
  await seedMigrationHostServer();
  const runId = await openRun();
  state.agentCalls = [];

  const res = await asOwner(() =>
    moveMigrationServiceData({
      ...CONNECT,
      runId,
      sourceKind: "application",
      sourceId: "dok-app-web",
    }),
  );

  assert.equal(res.moved, 2, "the named volume and the host directory");
  assert.equal(res.failed, 0);
  assert.ok(
    state.agentCalls.includes(
      "srv_migration_host:export:blink-web-abc_uploads",
    ),
    state.agentCalls.join(" | "),
  );
  assert.ok(
    state.agentCalls.includes(`${SERVER_1}:import:deplo-blink-web-uploads`),
  );
  assert.deepEqual(
    state.volumes[SERVER_1]["deplo-blink-web-uploads"],
    UPLOADS,
    "the destination must hold exactly what the source had",
  );
});

test("a source volume that is not on that host wipes nothing and is not a copy", async () => {
  await seedMigrationHostServer();
  delete state.volumes.srv_migration_host["blink-web-abc_uploads"];
  const before = state.volumes[SERVER_1]["deplo-blink-web-uploads"];
  const runId = await openRun();
  state.agentCalls = [];

  await asOwner(() =>
    moveMigrationServiceData({
      ...CONNECT,
      runId,
      sourceKind: "application",
      sourceId: "dok-app-web",
    }),
  );

  assert.deepEqual(
    state.volumes[SERVER_1]["deplo-blink-web-uploads"],
    before,
    "the destination must be untouched when the source has nothing",
  );
  assert.equal(
    state.agentCalls.some((c) => c.includes(":wipe:")),
    false,
    "a destination must never be emptied before the source has proven it has data",
  );
  const rows = await db.execute(
    `select outcome, message from migration_run_items where run_id = '${runId}' and source_kind = 'volume'`,
  );
  assert.equal(rows.rows[0].outcome, "skipped");
  assert.match(String(rows.rows[0].message), /holds nothing on Dokploy/);
});

test("a volume a never-started service has not created yet is not a loss", async () => {
  await seedMigrationHostServer();
  state.notFoundVolumes.add("blink-web-abc_uploads");
  state.sourceRunning = false;
  const runId = await openRun();

  const res = await asOwner(() =>
    moveMigrationServiceData({
      ...CONNECT,
      runId,
      sourceKind: "application",
      sourceId: "dok-app-web",
    }),
  );
  assert.equal(res.failed, 0, "nothing was lost, so nothing failed");

  const rows = await db.execute(
    `select outcome, message from migration_run_items where run_id = '${runId}' and source_kind = 'volume' and source_name = 'blink-web-abc_uploads'`,
  );
  assert.equal(rows.rows[0].outcome, "skipped");
  assert.match(
    String(rows.rows[0].message),
    /may simply never have been started/,
  );

  const app = await db.execute(
    "select data_copy_error from apps where id = 'prj_web'",
  );
  assert.equal(app.rows[0].data_copy_error, "");
});

test("a stopped stack whose compose lives in a repo still names its volumes", async () => {
  await seedMigrationHostServer();
  const runId = await openRun();

  const plan = await asOwner(() =>
    planMigrationDataMove({ ...CONNECT, runId }),
  );
  const stack = plan.find((s) => s.sourceName === "blink-stack");
  assert.ok(stack, JSON.stringify(plan.map((s) => s.sourceName)));
  assert.equal(stack.running, false);
  assert.deepEqual(
    stack.volumes.map((v) => `${v.sourceVolume}->${v.targetVolume}`),
    ["blinkstack-abc_store->deplo-blink-stack_store"],
  );

  const res = await asOwner(() =>
    moveMigrationServiceData({
      ...CONNECT,
      runId,
      sourceKind: "compose",
      sourceId: "dok-cmp-1",
    }),
  );
  assert.equal(res.moved, 1, res.notes.join(" | "));
  assert.equal(res.failed, 0);
});

test("a volume that did not come across is counted failed, not skipped", async () => {
  await seedMigrationHostServer();
  state.notFoundVolumes.add("blink-web-abc_uploads");
  state.sourceRunning = true;
  state.startRefusesNoContainer = false;
  const runId = await openRun();

  const res = await asOwner(() =>
    moveMigrationServiceData({
      ...CONNECT,
      runId,
      sourceKind: "application",
      sourceId: "dok-app-web",
    }),
  );
  assert.equal(res.failed, 1);

  const rows = await db.execute(
    `select outcome from migration_run_items where run_id = '${runId}' and source_name = 'blink-web-abc_uploads'`,
  );
  assert.equal(rows.rows[0].outcome, "failed");
  const run = await db.execute(
    `select failed from migration_runs where id = '${runId}'`,
  );
  assert.equal(Number(run.rows[0].failed), 1, "and the summary says so");
});
