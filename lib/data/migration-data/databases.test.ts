import {
  asOwner,
  CONNECT,
  closeHarness,
  DB_DATA,
  openHarness,
  openRun,
  resetHarness,
  seedMigrationHostServer,
  state,
} from "./migration-data-test-helpers";

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { TestDb } from "../../db/test-harness";
import { SERVER_1 } from "../app-graph-test-helpers";
import { redeployDatabase, restartDatabase } from "../databases/lifecycle";
import { moveMigrationServiceData } from "./move";

let db: TestDb;

before(async () => {
  db = await openHarness();
});

after(closeHarness);

beforeEach(resetHarness);

test("nothing is stopped on the source when the volumes are not on that machine", async () => {
  await seedMigrationHostServer();
  state.notFoundVolumes.add("blink-db-abc_data");
  state.sourceRunning = true;
  state.startRefusesNoContainer = false;
  const runId = await openRun();
  state.calls = [];

  const res = await asOwner(() =>
    moveMigrationServiceData({
      ...CONNECT,
      runId,
      sourceKind: "postgres",
      sourceId: "dok-pg-1",
    }),
  );

  assert.equal(res.failed, 1, "a service whose data did not move is a failure");
  assert.equal(res.moved, 0);
  assert.equal(
    state.calls.some((c) => c.endsWith(".stop")),
    false,
    "the source must still be up: nothing could have been copied off it",
  );
  assert.equal(
    state.agentCalls.some((c) => c.includes(":wipe:")),
    false,
    "and the destination must still hold whatever it had",
  );
  assert.match(res.notes.join(" "), /none of the volumes it names/);
  assert.equal(res.notes.join(" ").includes("{panel}"), false);

  const rows = await db.execute(
    `select outcome from migration_run_items where run_id = '${runId}' and source_id = 'dok-pg-1' order by seq desc`,
  );
  assert.equal(rows.rows[0].outcome, "failed");
  const row = await db.execute(
    "select status, data_copy_error from databases where id = 'db_blink'",
  );
  assert.equal(row.rows[0].status, "running", "it was never stopped");
  assert.match(String(row.rows[0].data_copy_error), /never copied/);
});

test("a database with nothing to copy is left RUNNING, not stopped", async () => {
  await seedMigrationHostServer();
  state.notFoundVolumes.add("blink-db-abc_data");
  state.sourceRunning = false;
  const runId = await openRun();
  state.agentCalls = [];

  const res = await asOwner(() =>
    moveMigrationServiceData({
      ...CONNECT,
      runId,
      sourceKind: "postgres",
      sourceId: "dok-pg-1",
    }),
  );
  assert.equal(res.moved, 0);
  assert.equal(res.failed, 0);

  assert.ok(state.agentCalls.includes(`${SERVER_1}:stop:db-blink-db`));
  assert.ok(
    state.agentCalls.includes(`${SERVER_1}:start:db-blink-db`),
    state.agentCalls.join(" | "),
  );
  const rows = await db.execute(
    "select status, data_copy_error from databases where id = 'db_blink'",
  );
  assert.equal(rows.rows[0].status, "running");
  assert.equal(rows.rows[0].data_copy_error, "");

  const items = await db.execute(
    `select message from migration_run_items where run_id = '${runId}' order by seq`,
  );
  const messages = items.rows.map((r) => String(r.message ?? ""));
  assert.ok(
    messages.some((m) => /Nothing was copied into it/.test(m)),
    messages.join(" | "),
  );
  assert.equal(
    messages.some((m) => /up on the copied data/.test(m)),
    false,
    "nothing was copied, so nothing may claim it was",
  );
});

test("a database whose container never came up is set up on the copied volume", async () => {
  await seedMigrationHostServer();
  const runId = await openRun();
  state.agentCalls = [];
  state.startRefusesNoContainer = true;

  const res = await asOwner(() =>
    moveMigrationServiceData({
      ...CONNECT,
      runId,
      sourceKind: "postgres",
      sourceId: "dok-pg-1",
    }),
  );

  const said = await db.execute(
    `select message from migration_run_items where run_id = '${runId}' and source_id = 'dok-pg-1' order by seq`,
  );
  assert.equal(
    res.failed,
    0,
    said.rows.map((r) => r.message).join(" | ") +
      " " +
      state.agentCalls.join(" | "),
  );
  assert.ok(
    state.agentCalls.includes(`${SERVER_1}:reroute:db-blink-db`),
    state.agentCalls.join(" | "),
  );
  const items = await db.execute(
    `select message from migration_run_items where run_id = '${runId}' and message like '%no container%'`,
  );
  assert.equal(
    items.rows.length,
    0,
    "the missing container is fixed, not reported",
  );
});

test("a copied database is started again and checked, and the report says what landed", async () => {
  await seedMigrationHostServer();
  const runId = await openRun();
  state.agentCalls = [];

  const res = await asOwner(() =>
    moveMigrationServiceData({
      ...CONNECT,
      runId,
      sourceKind: "postgres",
      sourceId: "dok-pg-1",
    }),
  );

  assert.equal(res.moved, 1);
  assert.equal(res.failed, 0);
  assert.deepEqual(
    state.volumes[SERVER_1]["deplo-db-blink-db_db-blink-db-data"],
    DB_DATA,
  );
  assert.ok(state.agentCalls.includes(`${SERVER_1}:stop:db-blink-db`));
  assert.ok(state.agentCalls.includes(`${SERVER_1}:start:db-blink-db`));

  const items = await db.execute(
    `select outcome, message from migration_run_items where run_id = '${runId}' order by seq`,
  );
  const messages = items.rows.map((r) => String(r.message ?? ""));
  assert.ok(
    messages.some((m) =>
      /Copied \d[\d.]* [kMG]?B \(compressed\) into deplo-db-blink-db_db-blink-db-data/.test(
        m,
      ),
    ),
    messages.join(" | "),
  );
  assert.ok(
    messages.some((m) => /is up on the copied data/.test(m)),
    messages.join(" | "),
  );
  const running = await db.execute(
    "select status from databases where id = 'db_blink'",
  );
  assert.equal(running.rows[0].status, "running");
});

test("a database whose data did not arrive refuses to be restarted", async () => {
  await seedMigrationHostServer();
  state.importRefusal = "the stream was truncated";
  const runId = await openRun();

  await asOwner(() =>
    moveMigrationServiceData({
      ...CONNECT,
      runId,
      sourceKind: "postgres",
      sourceId: "dok-pg-1",
    }),
  );

  const rows = await db.execute(
    "select data_copy_error from databases where id = 'db_blink'",
  );
  assert.match(String(rows.rows[0].data_copy_error), /truncated/);
  await assert.rejects(
    () => asOwner(() => restartDatabase("db_blink")),
    /did not come across/,
  );
  await assert.rejects(
    () => asOwner(() => redeployDatabase("db_blink")),
    /did not come across/,
  );
});
