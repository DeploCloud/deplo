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

import { runWithIdentity } from "../../auth/request-context";
import type { TestDb } from "../../db/test-harness";
import { SERVER_1 } from "../app-graph-test-helpers";
import { TEAM_B, USER_1 } from "../identity-test-helpers";
import { moveMigrationServiceData } from "./move";

let db: TestDb;

before(async () => {
  db = await openHarness();
});

after(closeHarness);

beforeEach(resetHarness);

test("a service this run did not import cannot be moved into anything", async () => {
  await seedMigrationHostServer();
  const runId = await openRun();
  await assert.rejects(
    () =>
      asOwner(() =>
        moveMigrationServiceData({
          ...CONNECT,
          runId,
          sourceKind: "application",
          sourceId: "dok-app-ghost",
        }),
      ),
    /did not create anything/,
  );
});

test("a service Dokploy no longer has is refused before anything else", async () => {
  await seedMigrationHostServer();
  const runId = await openRun();
  await assert.rejects(
    () =>
      asOwner(() =>
        moveMigrationServiceData({
          ...CONNECT,
          runId,
          sourceKind: "application",
          sourceId: "dok-app-vanished",
        }),
      ),
    /no longer on the Dokploy instance/,
  );
});

test("a run from another team is not a place to write a report", async () => {
  await seedMigrationHostServer();
  const runId = await openRun();
  await assert.rejects(
    () =>
      runWithIdentity({ userId: USER_1, teamId: TEAM_B }, () =>
        moveMigrationServiceData({
          ...CONNECT,
          runId,
          sourceKind: "application",
          sourceId: "dok-app-web",
        }),
      ),
    /scoped to a team the user no longer belongs to|does not belong to this team/,
  );
});

test("a destination that will not stop is never copied into, and the source starts again", async () => {
  await seedMigrationHostServer();
  const runId = await openRun();
  state.targetStopRefusal = "the stack is busy";
  state.agentCalls = [];

  const res = await asOwner(() =>
    moveMigrationServiceData({
      ...CONNECT,
      runId,
      sourceKind: "application",
      sourceId: "dok-app-web",
    }),
  );

  assert.equal(res.moved, 0);
  assert.equal(res.failed, 1);
  assert.equal(
    state.agentCalls.some((c) => c.startsWith(`${SERVER_1}:import`)),
    false,
    state.agentCalls.join(" | "),
  );
  assert.ok(state.calls.includes("application.start"), state.calls.join(" "));
  const rows = await db.execute(
    `select outcome, message from migration_run_items where run_id = '${runId}' and outcome = 'failed'`,
  );
  assert.match(String(rows.rows[0]?.message), /would not stop here/);
});

test("a destination never deployed here needs no stop, and is copied into", async () => {
  await seedMigrationHostServer();
  await db.execute(
    "update apps set status = 'idle', latest_deployment_id = null where id = 'prj_web'",
  );
  const runId = await openRun();
  state.targetStopRefusal =
    "open /data/stacks/blink-web.yml: no such file or directory";
  state.agentCalls = [];

  const res = await asOwner(() =>
    moveMigrationServiceData({
      ...CONNECT,
      runId,
      sourceKind: "application",
      sourceId: "dok-app-web",
    }),
  );

  assert.ok(res.moved >= 1, res.notes.join(" | "));
  assert.ok(
    state.agentCalls.some((c) => c.startsWith(`${SERVER_1}:import`)),
    state.agentCalls.join(" | "),
  );
  assert.equal(
    state.agentCalls.some((c) => c.startsWith(`${SERVER_1}:start`)),
    false,
    "an app that never ran here is not started after the copy",
  );
  const app = await db.execute(
    "select status, latest_deployment_id from apps where id = 'prj_web'",
  );
  assert.equal(app.rows[0].status, "idle");
  assert.equal(app.rows[0].latest_deployment_id, null);
});

test("a destination lost after the source stopped starts the source again", async () => {
  await seedMigrationHostServer();
  const runId = await openRun();
  state.goneAfterStop = true;

  const res = await asOwner(() =>
    moveMigrationServiceData({
      ...CONNECT,
      runId,
      sourceKind: "application",
      sourceId: "dok-app-web",
    }),
  );

  assert.equal(res.failed, 1);
  assert.ok(state.calls.includes("application.start"), state.calls.join(" "));
  const app = await db.execute(
    "select data_copy_error from apps where id = 'prj_web'",
  );
  assert.notEqual(app.rows[0].data_copy_error, "");
});

test("a host directory left behind for want of admin still blocks the deploy", async () => {
  await seedMigrationHostServer();
  await db.execute(
    `update users set is_instance_admin = false where id = '${USER_1}'`,
  );
  const runId = await openRun();

  const res = await asOwner(() =>
    moveMigrationServiceData({
      ...CONNECT,
      runId,
      sourceKind: "application",
      sourceId: "dok-app-web",
    }),
  );

  assert.equal(res.moved, 1, "the named volume still came across");
  assert.equal(res.failed, 1, "the host directory did not");
  const app = await db.execute(
    "select data_copy_error from apps where id = 'prj_web'",
  );
  assert.match(String(app.rows[0].data_copy_error), /\/etc\/dokploy\/x/);
});
