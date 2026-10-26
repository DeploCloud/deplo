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
import { migrationRunItems as itemsTable } from "../../db/schema/control-plane/migration";
import { SERVER_1 } from "../app-graph-test-helpers";
import { moveMigrationServiceData } from "./move";

let db: TestDb;

before(async () => {
  db = await openHarness();
});

after(closeHarness);

beforeEach(resetHarness);

test("a stop Dokploy refuses does not end the run when nothing is running", async () => {
  await seedMigrationHostServer();
  state.stopRefusal = "Command execution failed: spawn /bin/sh ENOENT";
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
  assert.equal(res.moved, 2, "the copy still ran");
  assert.equal(res.failed, 0);
  assert.match(res.notes.join(" "), /would not stop/);
});

test("a stop Dokploy refuses on a RUNNING service copies nothing", async () => {
  await seedMigrationHostServer();
  state.stopRefusal = "Command execution failed";
  const before = state.volumes[SERVER_1]["deplo-blink-web-uploads"];

  const runId = await openRun();
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
  assert.deepEqual(
    state.volumes[SERVER_1]["deplo-blink-web-uploads"],
    before,
    "a volume being written to must never be read out from under the writer",
  );
});

test("nothing is stopped until Deplo knows which server holds the data", async () => {
  const runId = await openRun();
  state.calls = [];
  state.agentCalls = [];
  await assert.rejects(
    () =>
      asOwner(() =>
        moveMigrationServiceData({
          ...CONNECT,
          runId,
          sourceKind: "application",
          sourceId: "dok-app-web",
        }),
      ),
    /no agent on the machine/,
  );
  assert.equal(
    state.calls.some((p) => p.endsWith(".stop")),
    false,
    "the source must still be running after a refusal",
  );
  assert.deepEqual(
    state.agentCalls,
    [],
    "and nothing of ours may be touched either",
  );
});

test("a source that is enrolled but will not answer US stops nothing and copies nothing", async () => {
  await seedMigrationHostServer();
  state.unreachableAgents.add("srv_migration_host");
  const runId = await openRun();
  state.calls = [];
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
    state.calls.some((p) => p.endsWith(".stop")),
    false,
    "the source must still be running on Dokploy",
  );
  assert.deepEqual(
    state.agentCalls,
    ["srv_migration_host:hello:"],
    "one question, and it gave up on the answer",
  );

  const items = await db.select().from(itemsTable);
  const failure = items.find((i) => i.outcome === "failed");
  assert.match(failure?.message ?? "", /cannot reach the agent/);
  assert.match(failure?.message ?? "", /on and connected to the internet/);
  assert.doesNotMatch(
    failure?.message ?? "",
    /9443|firewall|inbound|outbound/i,
  );
});

test("a source that dies MID-COPY says so, so the caller can stop the whole run", async () => {
  await seedMigrationHostServer();
  state.hostDiesMidCopy.add("srv_migration_host");
  const runId = await openRun();

  const res = await asOwner(() =>
    moveMigrationServiceData({
      ...CONNECT,
      runId,
      sourceKind: "application",
      sourceId: "dok-app-web",
    }),
  );
  assert.equal(res.sourceGone, true, "the MACHINE went, not just this volume");
  assert.ok(res.failed > 0);
});

test("an ordinary failed copy does NOT claim the machine went away", async () => {
  await seedMigrationHostServer();
  delete state.volumes.srv_migration_host["blink-web-abc_uploads"];
  const runId = await openRun();
  const res = await asOwner(() =>
    moveMigrationServiceData({
      ...CONNECT,
      runId,
      sourceKind: "application",
      sourceId: "dok-app-web",
    }),
  );
  assert.equal(res.sourceGone, false);
});

test("a volume the panel names in Deplo's own namespace is never read off our server", async () => {
  await seedMigrationHostServer();
  // Another team's app volume, and the panel claims the service mounts it.
  state.volumes.srv_migration_host["deplo-victim-uploads"] = UPLOADS;
  state.webMounts = [
    {
      Type: "volume",
      Name: "deplo-victim-uploads",
      Destination: "/app/uploads",
    },
  ];
  const landed = state.volumes[SERVER_1]["deplo-blink-web-uploads"];

  for (const running of [true, false]) {
    state.sourceRunning = running;
    state.agentCalls = [];
    const runId = await openRun();
    const res = await asOwner(() =>
      moveMigrationServiceData({
        ...CONNECT,
        runId,
        sourceKind: "application",
        sourceId: "dok-app-web",
      }),
    );
    assert.equal(res.moved, 0);
    assert.equal(
      state.agentCalls.some((c) => c.includes("deplo-victim-uploads")),
      false,
      `running=${running}: the name must not reach the agent`,
    );
    assert.deepEqual(
      state.volumes[SERVER_1]["deplo-blink-web-uploads"],
      landed,
    );
  }
});
