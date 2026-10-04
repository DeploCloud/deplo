import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { runWithIdentity } from "../auth/request-context";
import { seedIdentity, TEAM_A, TEAM_B, USER_1 } from "./identity-test-helpers";
import { TRUNCATE_PROJECT_GRAPH, seedApp } from "./app-graph-test-helpers";
import { seedDatabase } from "./backup-test-helpers";
import { seedServerRow } from "./infra-test-helpers";
import {
  clearContainerHistory,
  recordContainerInstances,
  recordContainerSample,
} from "../monitoring/container-history";
import type { ContainerInstanceMetrics } from "./container-metrics";
import { listServerWorkloads } from "./servers/workloads";

let db: TestDb;
let pg: PGlite;

const SERVER = "srv_target";
const OTHER = "srv_other";

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
});

after(async () => {
  clearContainerHistory();
  __resetTestDb();
  await pg.close();
});

beforeEach(async () => {
  clearContainerHistory();
  await pg.exec(`${TRUNCATE_PROJECT_GRAPH}
    truncate table databases, users, teams restart identity cascade;`);
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      { id: "user_member", teamId: TEAM_A, role: "member" },
    ],
  });
  await seedServerRow(db, { id: SERVER, name: "target", ip: "192.0.2.10" });
  await seedServerRow(db, { id: OTHER, name: "other", ip: "192.0.2.11" });
});

const asAdmin = () =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, () =>
    listServerWorkloads(SERVER),
  );

function container(
  name: string,
  over: Partial<ContainerInstanceMetrics> = {},
): ContainerInstanceMetrics {
  return {
    name,
    running: true,
    cpu: 2,
    memUsed: 100,
    memLimit: 1000,
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
    ...over,
  };
}

function telemetry(id: string, rows: ContainerInstanceMetrics[]) {
  const running = rows.filter((r) => r.running);
  recordContainerSample({
    id,
    online: true,
    ts: Date.now(),
    cpu: running.reduce((n, r) => n + r.cpu, 0),
    memUsed: running.reduce((n, r) => n + r.memUsed, 0),
    memLimit: 1000,
    memPct: 0,
    netRx: 0,
    netTx: 0,
    blockRead: 0,
    blockWrite: 0,
    pids: 1,
    running: running.length,
    containers: rows.length,
    hostCores: 2,
  });
  recordContainerInstances(id, rows);
}

test("lists every team's apps and databases here, linking only the viewer's teams", async () => {
  await seedApp(db, { id: "prj_web", serverId: SERVER });
  await seedApp(db, { id: "prj_api", serverId: SERVER, teamId: TEAM_B });
  await seedApp(db, { id: "prj_off", serverId: SERVER, status: "idle" });
  await seedApp(db, { id: "prj_far", serverId: OTHER });
  await seedDatabase(db, { id: "db_main", name: "main", serverId: SERVER });

  const rows = await asAdmin();

  assert.deepEqual(
    rows.map((r) => [r.id, r.kind, r.href]),
    [
      ["db_main", "database", "/alpha/storage/databases/db_main"],
      ["prj_off", "app", "/alpha/apps/prj_off"],
      ["prj_web", "app", "/alpha/apps/prj_web"],
      ["prj_api", "app", null],
    ],
  );
  assert.equal(rows.find((r) => r.id === "prj_off")?.status, "not_deployed");
  assert.equal(rows.find((r) => r.id === "db_main")?.engine, "postgres");
});

test("reads status, usage and restarts from the server's live stream", async () => {
  await seedApp(db, { id: "prj_web", serverId: SERVER });
  await seedApp(db, { id: "prj_loop", serverId: SERVER });
  telemetry("prj_web", [container("web-1", { cpu: 3, memUsed: 300 })]);
  telemetry("prj_loop", [
    container("loop-1", { state: "restarting", restartCount: 7 }),
    container("loop-2", { restartCount: 1 }),
  ]);

  const rows = await asAdmin();
  const web = rows.find((r) => r.id === "prj_web")!;
  const loop = rows.find((r) => r.id === "prj_loop")!;

  assert.equal(web.status, "active");
  assert.equal(web.cpu, 3);
  assert.equal(web.memUsed, 300);
  assert.deepEqual(
    web.containers.map((c) => c.name),
    ["web-1"],
  );
  assert.equal(loop.status, "restarting");
  assert.equal(loop.restarts, 8);
});

test("an active app with no fresh telemetry shows its stored status and no usage", async () => {
  await seedApp(db, { id: "prj_web", serverId: SERVER });

  const [web] = await asAdmin();

  assert.equal(web.status, "active");
  assert.equal(web.cpu, null);
  assert.deepEqual(web.containers, []);
});

test("refuses a member who is not an instance admin", async () => {
  await assert.rejects(
    () =>
      runWithIdentity({ userId: "user_member", teamId: TEAM_A }, () =>
        listServerWorkloads(SERVER),
      ),
    /instance admin/,
  );
});
