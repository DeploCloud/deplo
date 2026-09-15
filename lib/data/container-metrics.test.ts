import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { runWithIdentity } from "../auth/request-context";
import { seedIdentity, TEAM_A, TEAM_B, USER_1 } from "./identity-test-helpers";
import { seedServer, seedApp } from "./app-graph-test-helpers";
import { seedDatabase } from "./backup-test-helpers";
import {
  getAppMetrics,
  getDatabaseMetrics,
  getAppMetricsHistory,
  getDatabaseMetricsHistory,
  type ContainerMetricsSample,
} from "./container-metrics";
import {
  recordContainerSample,
  recordContainerInstances,
  clearContainerHistory,
} from "../monitoring/container-history";

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

const USER_B = "user_b";

const asOwner = <T>(fn: () => Promise<T>) =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);
const asOtherTeam = <T>(fn: () => Promise<T>) =>
  runWithIdentity({ userId: USER_B, teamId: TEAM_B }, fn);

const NOW = Date.now();

function sample(id: string, ts: number, cpu = 1): ContainerMetricsSample {
  return {
    id,
    online: true,
    ts,
    cpu,
    memUsed: 1,
    memLimit: 10,
    memPct: 10,
    netRx: 0,
    netTx: 0,
    blockRead: 0,
    blockWrite: 0,
    pids: 1,
    running: 1,
    containers: 1,
    hostCores: 8,
  };
}

beforeEach(async () => {
  clearContainerHistory();
  await pg.exec(
    `truncate table apps, databases, servers, activities, users, teams restart identity cascade;`,
  );
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      { id: USER_B, teamId: TEAM_B, role: "owner" },
    ],
  });
  await seedServer(db);
  await seedApp(db, { id: "prj_1", slug: "app-one" });
  await seedDatabase(db, { id: "db_1" });
});

test("getAppMetrics serves the newest buffered sample plus the breakdown cell", async () => {
  recordContainerSample(sample("prj_1", NOW - 5000, 11));
  recordContainerSample(sample("prj_1", NOW, 22));
  recordContainerInstances("prj_1", [
    {
      name: "app-one-web-1",
      running: true,
      cpu: 22,
      memUsed: 1,
      memLimit: 10,
      memPct: 10,
      netRx: 0,
      netTx: 0,
      blockRead: 0,
      blockWrite: 0,
      pids: 1,
      state: "running",
      health: "",
      restartCount: 0,
      netNsId: 0,
      netNsHost: false,
    },
  ]);

  const m = await asOwner(() => getAppMetrics("prj_1"));
  assert.ok(m);
  assert.equal(m.online, true);
  assert.equal(m.cpu, 22, "the LIVE value is the newest point, not the oldest");
  assert.equal(m.unsupported, false);
  assert.deepEqual(
    m.instances.map((i) => i.name),
    ["app-one-web-1"],
  );
});

test("an app with nothing buffered yet reads offline, never a fabricated zero-sample", async () => {
  const m = await asOwner(() => getAppMetrics("prj_1"));
  assert.ok(m);
  assert.equal(
    m.online,
    false,
    "no frame has arrived - that is an honest 'no data'",
  );
  assert.deepEqual(m.instances, []);
});

test("getDatabaseMetrics serves the buffer the same way", async () => {
  recordContainerSample(sample("db_1", NOW, 33));
  const m = await asOwner(() => getDatabaseMetrics("db_1"));
  assert.ok(m);
  assert.equal(m.cpu, 33);
});

test("getAppMetrics is team-scoped: a cross-team id gets NOTHING, buffer or not", async () => {
  recordContainerSample(sample("prj_1", NOW, 42));
  recordContainerInstances("prj_1", [
    {
      name: "app-one-web-1",
      running: true,
      cpu: 42,
      memUsed: 1,
      memLimit: 10,
      memPct: 10,
      netRx: 0,
      netTx: 0,
      blockRead: 0,
      blockWrite: 0,
      pids: 1,
      state: "running",
      health: "",
      restartCount: 0,
      netNsId: 0,
      netNsHost: false,
    },
  ]);

  assert.equal((await asOwner(() => getAppMetrics("prj_1")))?.cpu, 42);
  assert.equal(await asOtherTeam(() => getAppMetrics("prj_1")), null);
});

test("getDatabaseMetrics is team-scoped: a cross-team id gets NOTHING, buffer or not", async () => {
  recordContainerSample(sample("db_1", NOW, 43));
  assert.equal((await asOwner(() => getDatabaseMetrics("db_1")))?.cpu, 43);
  assert.equal(await asOtherTeam(() => getDatabaseMetrics("db_1")), null);
});

test("an unknown id is null for everyone (no buffer probe before the team gate)", async () => {
  recordContainerSample(sample("prj_nonexistent", NOW, 99));
  assert.equal(await asOwner(() => getAppMetrics("prj_nonexistent")), null);
  assert.equal(await asOwner(() => getDatabaseMetrics("db_nonexistent")), null);
});

test("metrics HISTORY reads are team-scoped from both sides", async () => {
  recordContainerSample(sample("prj_1", NOW));
  recordContainerSample(sample("db_1", NOW));
  assert.equal((await asOwner(() => getAppMetricsHistory("prj_1"))).length, 1);
  assert.equal(
    (await asOwner(() => getDatabaseMetricsHistory("db_1"))).length,
    1,
  );
  assert.equal(
    (await asOtherTeam(() => getAppMetricsHistory("prj_1"))).length,
    0,
  );
  assert.equal(
    (await asOtherTeam(() => getDatabaseMetricsHistory("db_1"))).length,
    0,
  );
});

test("the app and database gates are not interchangeable", async () => {
  recordContainerSample(sample("db_1", NOW, 50));
  recordContainerSample(sample("prj_1", NOW, 60));
  assert.equal(await asOwner(() => getAppMetrics("db_1")), null);
  assert.equal(await asOwner(() => getDatabaseMetrics("prj_1")), null);
  assert.equal((await asOwner(() => getAppMetricsHistory("db_1"))).length, 0);
  assert.equal(
    (await asOwner(() => getDatabaseMetricsHistory("prj_1"))).length,
    0,
  );
});
