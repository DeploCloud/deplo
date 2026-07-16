import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { monitoringSettings } from "../db/schema/control-plane";
import { runWithIdentity } from "../auth/request-context";
import { seedIdentity, TEAM_A, USER_1 } from "./identity-test-helpers";
import { seedServer, SERVER_1 } from "./app-graph-test-helpers";
import {
  getMonitoringSettings,
  isMetricsSavingEnabled,
  setSaveMetrics,
  __resetMonitoringSettingsMemo,
} from "./monitoring-settings";
import {
  HISTORY_WINDOW_MS,
  clearMetricsHistory,
  getMetricsHistory,
  latestSampleTs,
  pruneMetricsHistoryTo,
  recordMetricsSample,
} from "../monitoring/history";
import { runMetricsCollectorTick } from "../monitoring/collector";
import type { ServerMetrics } from "./monitoring";

/**
 * Tests for the "save metrics on server" feature: the `monitoring_settings`
 * singleton (missing row = default ON, `manage_infra`-gated write) and the
 * in-memory history ring buffer it controls (lib/monitoring/history.ts) —
 * online-samples-only, min-gap dedupe, window eviction, and the OFF switch
 * dropping what was buffered.
 */

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

/** A second, capability-poor principal: `view` only, so no `manage_infra`. */
const USER_VIEWER = "user_viewer";

beforeEach(async () => {
  await pg.exec(
    `truncate table monitoring_settings, activities, servers, users, teams restart identity cascade;`,
  );
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      { id: USER_VIEWER, teamId: TEAM_A, role: "viewer", capabilities: ["view"] },
    ],
  });
  await seedServer(db);
  // Both are process-global; a previous test's state must never leak in.
  clearMetricsHistory();
  __resetMonitoringSettingsMemo();
});

const asOwner = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);

const asViewer = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: USER_VIEWER, teamId: TEAM_A }, fn);

/** A minimal online measurement at `ts` (override any field). */
function sample(
  ts: number,
  over: Partial<ServerMetrics> = {},
): ServerMetrics {
  return {
    serverId: SERVER_1,
    online: true,
    traefik: false,
    cpu: 10,
    cpuCores: 4,
    memUsed: 1,
    memTotal: 2,
    memPct: 50,
    diskUsed: 1,
    diskTotal: 2,
    diskPct: 50,
    netRx: 0,
    netTx: 0,
    load: [0.1, 0.2, 0.3],
    uptimeSec: 60,
    containers: 1,
    agentVersion: "1.0.0",
    expectedAgentVersion: "1.0.0",
    agentOutdated: false,
    ts,
    ...over,
  };
}

/* ------------------------------------------------------------------ */
/* The ring buffer                                                     */
/* ------------------------------------------------------------------ */

test("recordMetricsSample keeps online measurements, oldest first", () => {
  // Wall-clock-relative timestamps: getMetricsHistory evicts by Date.now(), so a
  // sample stamped in 1970 would be "older than the window" on arrival.
  const t0 = Date.now() - 5000;
  recordMetricsSample(sample(t0));
  recordMetricsSample(sample(t0 + 1000));
  const hist = getMetricsHistory(SERVER_1);
  assert.deepEqual(
    hist.map((s) => s.ts),
    [t0, t0 + 1000],
  );
  assert.equal(latestSampleTs(SERVER_1), t0 + 1000);
});

test("offline snapshots are refused — a gap, never a zero", () => {
  recordMetricsSample(sample(Date.now(), { online: false }));
  assert.deepEqual(getMetricsHistory(SERVER_1), []);
});

test("a sample landing within the min gap of the last is dropped (two viewers)", () => {
  const t0 = Date.now() - 5000;
  recordMetricsSample(sample(t0));
  recordMetricsSample(sample(t0 + 100)); // a second tab's poll, 100ms later
  recordMetricsSample(sample(t0 + 1000));
  assert.deepEqual(
    getMetricsHistory(SERVER_1).map((s) => s.ts),
    [t0, t0 + 1000],
  );
});

test("samples older than the window are evicted when a new one lands", () => {
  const now = Date.now();
  recordMetricsSample(sample(now - HISTORY_WINDOW_MS - 1000));
  recordMetricsSample(sample(now));
  assert.deepEqual(
    getMetricsHistory(SERVER_1).map((s) => s.ts),
    [now],
  );
});

test("pruneMetricsHistoryTo forgets servers not in the live fleet", () => {
  const t0 = Date.now();
  recordMetricsSample(sample(t0));
  recordMetricsSample(sample(t0, { serverId: "srv_gone" }));
  pruneMetricsHistoryTo(new Set([SERVER_1]));
  assert.equal(getMetricsHistory(SERVER_1).length, 1);
  assert.deepEqual(getMetricsHistory("srv_gone"), []);
});

/* ------------------------------------------------------------------ */
/* The settings singleton                                              */
/* ------------------------------------------------------------------ */

test("missing row reads back as the default: saving ON", async () => {
  await asOwner(async () => {
    const s = await getMonitoringSettings();
    assert.equal(s.saveMetrics, true);
    assert.equal(s.updatedAt, null);
  });
  assert.equal((await db.select().from(monitoringSettings)).length, 0);
});

test("setSaveMetrics(false) persists, reads back, and drops the buffer", async () => {
  recordMetricsSample(sample(1_000_000));
  await asOwner(async () => {
    const s = await setSaveMetrics(false);
    assert.equal(s.saveMetrics, false);
    assert.ok(s.updatedAt);
    assert.equal((await getMonitoringSettings()).saveMetrics, false);
  });
  // OFF must mean nothing stays saved, not "stops growing".
  assert.deepEqual(getMetricsHistory(SERVER_1), []);
});

test("two writes upsert the one singleton row", async () => {
  await asOwner(async () => {
    await setSaveMetrics(false);
    await setSaveMetrics(true);
  });
  const rows = await db.select().from(monitoringSettings);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].saveMetrics, true);
});

test("a viewer without manage_infra cannot flip the switch", async () => {
  await asViewer(async () => {
    await assert.rejects(() => setSaveMetrics(false), /permission/i);
  });
  assert.equal((await db.select().from(monitoringSettings)).length, 0);
});

test("the poll-path memo is busted by a write", async () => {
  await asOwner(async () => {
    assert.equal(await isMetricsSavingEnabled(), true); // memoises the default
    await setSaveMetrics(false);
    assert.equal(await isMetricsSavingEnabled(), false); // sees the write at once
  });
});

/* ------------------------------------------------------------------ */
/* The collector tick (smoke — no agent to dial in pglite)             */
/* ------------------------------------------------------------------ */

test("a collector tick with saving off records nothing", async () => {
  await asOwner(() => setSaveMetrics(false));
  await runMetricsCollectorTick();
  assert.deepEqual(getMetricsHistory(SERVER_1), []);
});

test("a collector tick skips servers with no enrolled agent", async () => {
  // The seeded server has no agent cert, so the tick has nobody to dial — it
  // must return quietly with an empty buffer rather than fabricate a sample.
  await runMetricsCollectorTick();
  assert.deepEqual(getMetricsHistory(SERVER_1), []);
});
