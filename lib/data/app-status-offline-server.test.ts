import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { servers as serversTable } from "../db/schema/control-plane/servers";
import { runWithIdentity } from "../auth/request-context";
import { seedIdentity, TEAM_A } from "./identity-test-helpers";
import {
  seedApp,
  seedServer,
  SERVER_1,
  TRUNCATE_PROJECT_GRAPH,
} from "./app-graph-test-helpers";
import { recordContainerSample } from "../monitoring/container-history";
import type { ContainerMetricsSample } from "./container-metrics";
import { displayStatus } from "../apps/display-status";
import { doorClosed, doorOpened } from "../infra/agent-link/registry";
import { getServerById } from "./servers/roster";
import { getAppRuntime } from "./console/runtime";
import {
  loadOverviewAppStates,
  type OverviewAppState,
} from "./console/overview-app-states";

let db: TestDb;
let pg: PGlite;
const OWNER = "u_owner";
let seq = 0;

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
});
after(async () => {
  __resetTestDb();
  await pg.close();
});

beforeEach(async () => {
  await pg.exec(`${TRUNCATE_PROJECT_GRAPH}
    truncate table membership_capabilities, memberships, users, teams
    restart identity cascade;`);
  await seedIdentity(db, {
    users: [{ id: OWNER, teamId: TEAM_A, role: "owner" }],
  });
  await seedServer(db);
});

async function runningApp(): Promise<string> {
  const id = `prj_offline_${++seq}`;
  await seedApp(db, { id, slug: `off${seq}`, teamId: TEAM_A });
  // The last frame before the server went away said it ran.
  recordContainerSample({
    ...({} as ContainerMetricsSample),
    id,
    online: true,
    ts: Date.now(),
    running: 1,
    containers: 1,
  });
  return id;
}

const shown = (s: OverviewAppState) =>
  displayStatus(s.status, s.runtime ? { ...s.runtime, missing: [] } : null);

const overview = (appId: string) =>
  runWithIdentity({ userId: OWNER, teamId: TEAM_A }, () =>
    loadOverviewAppStates([appId], async () => {
      throw new Error("an offline server is not asked");
    }),
  );

test("an App on an offline server is not shown as running", async () => {
  const appId = await runningApp();
  await db
    .update(serversTable)
    .set({ status: "offline" })
    .where(eq(serversTable.id, SERVER_1));
  const [state] = await overview(appId);
  assert.equal(state.runtime?.unreachable, true);
  assert.equal(shown(state), "unreachable");
});

test("an App on an online server keeps what telemetry says", async () => {
  const appId = await runningApp();
  const [state] = await overview(appId);
  assert.equal(state.runtime?.unreachable, false);
  assert.equal(shown(state), "active");
});

test("a stopped App on an offline server still reads stopped", async () => {
  const id = `prj_offline_${++seq}`;
  await seedApp(db, { id, teamId: TEAM_A, status: "idle" });
  await db
    .update(serversTable)
    .set({ status: "offline" })
    .where(eq(serversTable.id, SERVER_1));
  const [state] = await overview(id);
  assert.equal(state.runtime, null);
  assert.equal(shown(state), "idle");
});

test("a server whose agent is not linked is offline at once, whatever its stored status says", async (t) => {
  t.after(() => doorClosed());
  const appId = await runningApp();
  await db
    .update(serversTable)
    .set({ agentCertFingerprint: "fp-live" })
    .where(eq(serversTable.id, SERVER_1));
  doorOpened();
  assert.equal((await getServerById(SERVER_1))?.status, "offline");
  const [state] = await overview(appId);
  assert.equal(shown(state), "unreachable");
});

test("reading an App on a server that is not answering fails at once, with no wait for its link", async (t) => {
  t.after(() => doorClosed());
  const appId = await runningApp();
  await db
    .update(serversTable)
    .set({ agentCertFingerprint: "fp-live" })
    .where(eq(serversTable.id, SERVER_1));
  doorOpened();
  const started = performance.now();
  const runtime = await runWithIdentity({ userId: OWNER, teamId: TEAM_A }, () =>
    getAppRuntime(appId),
  );
  assert.equal(runtime?.unreachable, true);
  assert.ok(performance.now() - started < 1_000, "answered without waiting");
});
