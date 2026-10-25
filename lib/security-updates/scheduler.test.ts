import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";

import { InventoryStatus } from "../agent/gen/agent";
import { __resetLocalLeases } from "../backups/lease";
import { __resetTestDb, __setTestDb } from "../db/client";
import { deploMoves } from "../db/schema/control-plane/deplo-move";
import { instanceSettings } from "../db/schema/control-plane/instance";
import { workloadImages } from "../db/schema/control-plane/security-updates";
import { makeTestDb, type TestDb } from "../db/test-harness";
import { invalidateFrozen } from "../data/deplo-move/freeze";
import { seedApp, seedServer } from "../data/app-graph-test-helpers";
import { seedIdentity, TEAM_A, USER_1 } from "../data/identity-test-helpers";
import { __setAgentConnectorForTest } from "../infra/agent-client/connect";
import type { AgentConnection } from "../infra/agent-client/connection";
import {
  captureFetch,
  type FetchCapture,
} from "../notify/fetch-capture-test-helpers";
import { runSecurityUpdatesTick } from "./scheduler";
import { securityState } from "./state";

let db: TestDb;
let pg: PGlite;
let capture: FetchCapture | null = null;
let listed = 0;
let caps = ["image-inventory"];
const T0 = "2026-01-01T00:00:00.000Z";
const NOW = new Date("2026-10-25T10:00:00Z");

const agent = {
  hello: async () => ({ capabilities: caps }),
  listWorkloadImages: async () => {
    listed++;
    return {
      images: [
        {
          projectId: "prj_web",
          appId: "",
          service: "web",
          imageRef: "deplo/web:dpl_1",
          imageId: "sha256:" + "1".repeat(64),
          repoDigests: [],
          running: true,
        },
      ],
    };
  },
  inventoryImage: async () => ({
    status: InventoryStatus.INVENTORY_STATUS_OK,
    error: "",
    distroId: "debian",
    distroVersion: "12",
    workingDir: "/app",
    scannerVersion: "1.54.1",
    durationMs: 1,
    packages: [
      {
        purl: "pkg:npm/minimist@1.2.5",
        location: "/app/x",
        name: "",
        version: "",
        type: "npm",
      },
    ],
  }),
  close() {},
} as unknown as AgentConnection;

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
});

after(async () => {
  __setAgentConnectorForTest();
  __resetTestDb();
  await pg.close();
});

beforeEach(async () => {
  await pg.exec(
    `truncate table security_findings, workload_images, image_inventory_packages, image_inventories,
       kev_cves, osv_affected, deplo_moves, scheduler_lease, apps, servers, users, teams, instance_settings
       restart identity cascade;`,
  );
  await seedIdentity(db, {
    users: [{ id: USER_1, teamId: TEAM_A, role: "owner" }],
  });
  await db
    .insert(instanceSettings)
    .values({ id: "default", updatedAt: T0 })
    .onConflictDoNothing();
  await seedServer(db);
  await seedApp(db, { id: "prj_web", slug: "web" });
  listed = 0;
  caps = ["image-inventory"];
  invalidateFrozen();
  __resetLocalLeases();
  __setAgentConnectorForTest(async () => agent);
  capture = captureFetch((url) =>
    url.endsWith("/querybatch")
      ? new Response(JSON.stringify({ results: [{}] }), { status: 200 })
      : new Response("{}", { status: 503 }),
  );
});

afterEach(() => {
  capture?.restore();
  capture = null;
});

test("a tick records workloads, matches them and stamps the check", async () => {
  await runSecurityUpdatesTick(NOW);
  assert.equal(listed, 1);
  assert.equal((await db.select().from(workloadImages)).length, 1);
  const s = await securityState();
  assert.equal(s.checkedAt, NOW.toISOString());
  assert.equal(s.failingSince, null);
});

test("switched off, a tick asks no server", async () => {
  await db.update(instanceSettings).set({ securityUpdatesEnabled: false });
  await runSecurityUpdatesTick(NOW);
  assert.equal(listed, 0);
});

test("frozen by a Deplo move, a tick does nothing", async () => {
  await db.insert(deploMoves).values({
    id: "dmove_1",
    side: "target",
    state: "copying",
    startedBy: "admin",
    createdAt: T0,
    updatedAt: T0,
  });
  invalidateFrozen();
  await runSecurityUpdatesTick(NOW);
  assert.equal(listed, 0);
});

test("a server whose agent cannot read images is left alone", async () => {
  caps = [];
  await runSecurityUpdatesTick(NOW);
  assert.equal(listed, 0);
  assert.equal((await db.select().from(workloadImages)).length, 0);
});

test("OSV down: the check is not stamped and the failure start is kept", async () => {
  capture!.restore();
  capture = captureFetch(() => new Response("{}", { status: 503 }));
  await runSecurityUpdatesTick(NOW);
  await runSecurityUpdatesTick(new Date("2026-10-25T10:05:00Z"));
  const s = await securityState();
  assert.equal(s.checkedAt, null);
  assert.equal(
    s.failingSince,
    NOW.toISOString(),
    "the first failure is what the status line shows",
  );
});
