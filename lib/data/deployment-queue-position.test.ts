import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { PGlite } from "@electric-sql/pglite";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { runWithIdentity } from "../auth/request-context";
import {
  seedIdentity,
  TRUNCATE_IDENTITY,
  TEAM_A,
  TEAM_B,
} from "./identity-test-helpers";
import {
  seedServer,
  seedApp,
  seedDeployment,
  SERVER_1,
  TRUNCATE_PROJECT_GRAPH,
} from "./app-graph-test-helpers";
import { getQueuePosition } from "./deployments";

/**
 * `getQueuePosition` against pglite — the 1-based slot the deployment-detail
 * "in queue" banner shows. It mirrors the deploy queue's drain order (see
 * deploy-queue `pickNext`): per OWNING SERVER, oldest-first by (createdAt, seq),
 * counting only queued rows ahead. null for a non-queued or foreign-team row.
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

const OWNER = "u_owner";
const OWNER_B = "u_owner_b";
const SVC = "prj_svc";
const SVC2 = "prj_svc2";
const SERVER_2 = "srv_2";

const as = <T>(userId: string, teamId: string, fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId, teamId }, fn);

// Distinct, increasing createdAt so FIFO order is deterministic on its own.
const at = (n: number) => `2026-01-01T00:00:0${n}.000Z`;

beforeEach(async () => {
  await pg.exec(TRUNCATE_PROJECT_GRAPH);
  await pg.exec(TRUNCATE_IDENTITY);
  await seedIdentity(db, {
    teams: [
      { id: TEAM_A, slug: "alpha" },
      { id: TEAM_B, slug: "beta" },
    ],
    users: [
      { id: OWNER, teamId: TEAM_A, role: "owner" },
      { id: OWNER_B, teamId: TEAM_B, role: "owner" },
    ],
  });
  await seedServer(db); // SERVER_1 (default)
  await seedServer(db, SERVER_2);
  await seedApp(db, { id: SVC, teamId: TEAM_A, serverId: SERVER_1 });
  await seedApp(db, {
    id: SVC2,
    teamId: TEAM_A,
    slug: "svc2",
    serverId: SERVER_2,
  });
});

test("positions queued builds oldest-first (1 = next to build)", async () => {
  await seedDeployment(db, { id: "d1", appId: SVC, status: "queued", createdAt: at(1), serverId: SERVER_1 });
  await seedDeployment(db, { id: "d2", appId: SVC, status: "queued", createdAt: at(2), serverId: SERVER_1 });
  await seedDeployment(db, { id: "d3", appId: SVC, status: "queued", createdAt: at(3), serverId: SERVER_1 });
  await as(OWNER, TEAM_A, async () => {
    assert.equal(await getQueuePosition("d1"), 1);
    assert.equal(await getQueuePosition("d2"), 2);
    assert.equal(await getQueuePosition("d3"), 3);
  });
});

test("counts only queued rows ahead — a building/ready one doesn't shift it", async () => {
  await seedDeployment(db, { id: "d_building", appId: SVC, status: "building", createdAt: at(1), serverId: SERVER_1 });
  await seedDeployment(db, { id: "d_ready", appId: SVC, status: "ready", createdAt: at(2), serverId: SERVER_1 });
  await seedDeployment(db, { id: "d_queued", appId: SVC, status: "queued", createdAt: at(3), serverId: SERVER_1 });
  assert.equal(
    await as(OWNER, TEAM_A, () => getQueuePosition("d_queued")),
    1,
    "the only queued row is next, regardless of an in-flight build ahead",
  );
});

test("a non-queued deployment has no position", async () => {
  await seedDeployment(db, { id: "d_ready", appId: SVC, status: "ready", serverId: SERVER_1 });
  await seedDeployment(db, { id: "d_building", appId: SVC, status: "building", serverId: SERVER_1 });
  await as(OWNER, TEAM_A, async () => {
    assert.equal(await getQueuePosition("d_ready"), null);
    assert.equal(await getQueuePosition("d_building"), null);
    assert.equal(await getQueuePosition("does_not_exist"), null);
  });
});

test("position is scoped to the owning server", async () => {
  await seedDeployment(db, { id: "s1a", appId: SVC, status: "queued", createdAt: at(1), serverId: SERVER_1 });
  await seedDeployment(db, { id: "s1b", appId: SVC, status: "queued", createdAt: at(2), serverId: SERVER_1 });
  await seedDeployment(db, { id: "s2a", appId: SVC2, status: "queued", createdAt: at(1), serverId: SERVER_2 });
  await seedDeployment(db, { id: "s2b", appId: SVC2, status: "queued", createdAt: at(2), serverId: SERVER_2 });
  await as(OWNER, TEAM_A, async () => {
    assert.equal(await getQueuePosition("s1b"), 2, "only SERVER_1's queue counts");
    assert.equal(await getQueuePosition("s2a"), 1, "SERVER_2 is a separate queue");
  });
});

test("falls back to the app's server when the row's server_id is null", async () => {
  // Legacy rows predate the denormalized server_id → effective server is the
  // app's (SERVER_1), and they must still form a single ordered queue.
  await seedDeployment(db, { id: "legacy_ahead", appId: SVC, status: "queued", createdAt: at(1) });
  await seedDeployment(db, { id: "legacy_target", appId: SVC, status: "queued", createdAt: at(2) });
  assert.equal(
    await as(OWNER, TEAM_A, () => getQueuePosition("legacy_target")),
    2,
  );
});

test("a caller can't read another team's queue position (isolation)", async () => {
  await seedDeployment(db, { id: "d_queued", appId: SVC, status: "queued", serverId: SERVER_1 });
  assert.equal(
    await as(OWNER_B, TEAM_B, () => getQueuePosition("d_queued")),
    null,
  );
});
