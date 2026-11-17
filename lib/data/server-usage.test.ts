import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { runWithIdentity } from "../auth/request-context";
import {
  seedIdentity,
  TEAM_A,
  TRUNCATE_IDENTITY,
} from "./identity-test-helpers";
import {
  SERVER_1,
  seedApp,
  seedServer,
  TRUNCATE_PROJECT_GRAPH,
} from "./app-graph-test-helpers";
import { apps } from "../db/schema/control-plane/apps";
import { clusters } from "../db/schema/control-plane/clusters";
import {
  clearMetricsHistory,
  recordMetricsSample,
} from "../monitoring/history";
import { serverUsages, type ServerMetrics } from "./monitoring";
import { appCounts } from "./servers/workloads";

let db: TestDb;
let pg: PGlite;
const ADMIN = "admin1";
const MEMBER = "member2";

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
});

after(async () => {
  clearMetricsHistory();
  __resetTestDb();
  await pg.close();
});

beforeEach(async () => {
  clearMetricsHistory();
  await pg.exec(`${TRUNCATE_PROJECT_GRAPH}
    truncate table clusters restart identity cascade;
    ${TRUNCATE_IDENTITY}`);
  await seedIdentity(db, {
    users: [
      { id: ADMIN, teamId: TEAM_A, role: "owner", isInstanceAdmin: true },
      { id: MEMBER, teamId: TEAM_A, role: "member", isInstanceAdmin: false },
    ],
  });
  await seedServer(db);
});

const as = <T>(userId: string, fn: () => Promise<T>) =>
  runWithIdentity({ userId, teamId: TEAM_A }, fn);

const sample = (serverId: string, ts: number): ServerMetrics => ({
  serverId,
  online: true,
  traefik: true,
  cpu: 12,
  cpuCores: 4,
  memUsed: 2e9,
  memTotal: 8e9,
  memPct: 25,
  memFree: 6e9,
  memCache: 0,
  diskUsed: 10e9,
  diskTotal: 100e9,
  diskPct: 10,
  netRx: 0,
  netTx: 0,
  load: [0, 0, 0],
  uptimeSec: 1,
  containers: 3,
  agentVersion: null,
  expectedAgentVersion: "",
  source: "",
  ts,
});

test("a server's usage is its newest reading, and only for an admin", async () => {
  recordMetricsSample(sample(SERVER_1, Date.now()));
  const got = await as(ADMIN, () => serverUsages([SERVER_1, "srv_silent"]));
  assert.deepEqual(got.get(SERVER_1), {
    cpu: 12,
    cores: 4,
    memUsed: 2e9,
    memTotal: 8e9,
    diskUsed: 10e9,
    diskTotal: 100e9,
  });
  assert.equal(got.has("srv_silent"), false);
  await assert.rejects(() => as(MEMBER, () => serverUsages([SERVER_1])));
});

test("a reading older than the history window is not shown as current", async () => {
  recordMetricsSample(sample(SERVER_1, Date.now() - 60 * 60_000));
  const got = await as(ADMIN, () => serverUsages([SERVER_1]));
  assert.equal(got.size, 0);
});

test("apps are counted per server and per cluster, leaving out ones being deleted", async () => {
  await db
    .insert(clusters)
    .values({ id: "clu_1", name: "eu", createdAt: "2026-01-01T00:00:00.000Z" });
  await seedApp(db, { id: "app_a", slug: "a" });
  await seedApp(db, { id: "app_b", slug: "b" });
  await seedApp(db, { id: "app_c", slug: "c" });
  await db.update(apps).set({ clusterId: "clu_1" }).where(eq(apps.id, "app_b"));
  await db
    .update(apps)
    .set({ deletingAt: "2026-01-01T00:00:00.000Z" })
    .where(eq(apps.id, "app_c"));
  const { byServer, byCluster } = await as(ADMIN, () => appCounts());
  assert.equal(byServer.get(SERVER_1), 2);
  assert.equal(byCluster.get("clu_1"), 1);
});
