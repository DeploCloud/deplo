import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PGlite } from "@electric-sql/pglite";
import { and, eq } from "drizzle-orm";

// Point build staging at a throwaway dir BEFORE the build module graph loads
// (deploy-queue imports build.ts, which reads DEPLO_DATA_DIR at module load).
process.env.DEPLO_DATA_DIR = mkdtempSync(join(tmpdir(), "deplo-queue-"));

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import {
  deployments as deploymentsTable,
  servers as serversTable,
} from "../db/schema/control-plane";
import { seedIdentity, TEAM_A, USER_1 } from "../data/identity-test-helpers";
import {
  seedServer,
  seedService,
  seedDeployment,
  TRUNCATE_PROJECT_GRAPH,
} from "../data/service-graph-test-helpers";
import {
  enqueueDeployment,
  startDeployQueue,
  __setRunnerForTest,
  __resetQueueForTest,
} from "./deploy-queue";
import { startDeployment } from "./build";

/**
 * Per-server deploy-queue tests (pglite). The queue is an in-process dispatcher
 * over durable `queued` rows; the real runner (runDeploymentGuarded) is swapped
 * for a controllable fake so the slot/ordering/exclusion logic is exercised
 * without a build. The fake mimics the one property the queue leans on:
 * `runDeployment`'s atomic `queued -> building` claim.
 */

let db: TestDb;
let pg: PGlite;

const SRV_A = "srv_a";
const SRV_B = "srv_b";

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
});

after(async () => {
  __resetTestDb();
  __resetQueueForTest();
  await pg.close();
});

beforeEach(async () => {
  __resetQueueForTest();
  await pg.exec(`${TRUNCATE_PROJECT_GRAPH}
    truncate table users, teams restart identity cascade;`);
  await seedIdentity(db, { users: [{ id: USER_1, teamId: TEAM_A, role: "owner" }] });
});

/** A controllable deploy runner: records dispatch order and lets the test settle
 *  each running deploy on command (mimicking runDeployment's claim + terminal). */
function makeFakeRunner() {
  const started: string[] = [];
  const resolvers = new Map<string, () => void>();
  const runner = async (depId: string): Promise<void> => {
    started.push(depId);
    // The atomic slot hand-off the queue relies on: queued -> building.
    await db
      .update(deploymentsTable)
      .set({ status: "building" })
      .where(
        and(
          eq(deploymentsTable.id, depId),
          eq(deploymentsTable.status, "queued"),
        ),
      );
    await new Promise<void>((resolve) => resolvers.set(depId, resolve));
  };
  const finish = async (depId: string): Promise<void> => {
    await db
      .update(deploymentsTable)
      .set({ status: "ready" })
      .where(eq(deploymentsTable.id, depId));
    resolvers.get(depId)?.();
    resolvers.delete(depId);
  };
  return { runner, started, finish };
}

async function waitFor(
  cond: () => boolean,
  label: string,
  timeoutMs = 2000,
): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs)
      throw new Error(`waitFor timed out: ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Let any pending pump work flush, so a "nothing else started" assertion is safe. */
async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 40));
}

async function setConcurrency(serverId: string, n: number): Promise<void> {
  await db
    .update(serversTable)
    .set({ deployConcurrency: n })
    .where(eq(serversTable.id, serverId));
}

async function statusOf(depId: string): Promise<string | undefined> {
  const rows = await db
    .select({ status: deploymentsTable.status })
    .from(deploymentsTable)
    .where(eq(deploymentsTable.id, depId))
    .limit(1);
  return rows[0]?.status;
}

test("concurrency 1: one deploy at a time per server, FIFO", async () => {
  const { runner, started, finish } = makeFakeRunner();
  __setRunnerForTest(runner);
  await seedServer(db, SRV_A);
  await seedService(db, { id: "svc_x", serverId: SRV_A, status: "queued" });
  await seedService(db, { id: "svc_y", serverId: SRV_A, status: "queued" });
  await seedDeployment(db, { id: "d_x", serviceId: "svc_x", serverId: SRV_A, status: "queued", createdAt: "2026-01-01T00:00:01.000Z" });
  await seedDeployment(db, { id: "d_y", serviceId: "svc_y", serverId: SRV_A, status: "queued", createdAt: "2026-01-01T00:00:02.000Z" });

  enqueueDeployment({ depId: "d_x", serverId: SRV_A, serviceId: "svc_x" });
  enqueueDeployment({ depId: "d_y", serverId: SRV_A, serviceId: "svc_y" });

  await waitFor(() => started.length === 1, "first deploy started");
  await settle();
  assert.deepEqual(started, ["d_x"], "only the oldest runs; the second waits for the slot");
  assert.equal(await statusOf("d_y"), "queued", "second deploy still queued");

  await finish("d_x");
  await waitFor(() => started.length === 2, "second deploy started after first finished");
  assert.deepEqual(started, ["d_x", "d_y"]);
});

test("deploys on different servers run in parallel", async () => {
  const { runner, started, finish } = makeFakeRunner();
  __setRunnerForTest(runner);
  await seedServer(db, SRV_A);
  await seedServer(db, SRV_B);
  await seedService(db, { id: "svc_a", serverId: SRV_A, status: "queued" });
  await seedService(db, { id: "svc_b", serverId: SRV_B, status: "queued" });
  await seedDeployment(db, { id: "d_a", serviceId: "svc_a", serverId: SRV_A, status: "queued" });
  await seedDeployment(db, { id: "d_b", serviceId: "svc_b", serverId: SRV_B, status: "queued" });

  enqueueDeployment({ depId: "d_a", serverId: SRV_A, serviceId: "svc_a" });
  enqueueDeployment({ depId: "d_b", serverId: SRV_B, serviceId: "svc_b" });

  await waitFor(() => started.length === 2, "both deploys started");
  assert.deepEqual([...started].sort(), ["d_a", "d_b"], "one on each server, concurrently");
  await finish("d_a");
  await finish("d_b");
});

test("concurrency 2: two distinct services run, but never two of the same service", async () => {
  const { runner, started, finish } = makeFakeRunner();
  __setRunnerForTest(runner);
  await seedServer(db, SRV_A);
  await setConcurrency(SRV_A, 2);
  await seedService(db, { id: "svc_x", serverId: SRV_A, status: "queued" });
  await seedService(db, { id: "svc_y", serverId: SRV_A, status: "queued" });
  // Two queued deploys for the SAME service x, plus one for y. (Seeded directly —
  // the enqueue-time collapse lives in startDeployment, not the queue.)
  await seedDeployment(db, { id: "x1", serviceId: "svc_x", serverId: SRV_A, status: "queued", createdAt: "2026-01-01T00:00:01.000Z" });
  await seedDeployment(db, { id: "x2", serviceId: "svc_x", serverId: SRV_A, status: "queued", createdAt: "2026-01-01T00:00:02.000Z" });
  await seedDeployment(db, { id: "y1", serviceId: "svc_y", serverId: SRV_A, status: "queued", createdAt: "2026-01-01T00:00:03.000Z" });

  enqueueDeployment({ depId: "x1", serverId: SRV_A, serviceId: "svc_x" });
  enqueueDeployment({ depId: "x2", serverId: SRV_A, serviceId: "svc_x" });
  enqueueDeployment({ depId: "y1", serverId: SRV_A, serviceId: "svc_y" });

  await waitFor(() => started.length === 2, "two slots filled");
  await settle();
  assert.deepEqual(started, ["x1", "y1"], "x1 + y1 run; x2 waits though a slot rule would allow it (same service as x1)");
  assert.equal(await statusOf("x2"), "queued", "the second same-service deploy is held back");

  await finish("x1");
  await waitFor(() => started.includes("x2"), "x2 runs once x1 (its service) frees");
  assert.deepEqual(started, ["x1", "y1", "x2"]);
  await finish("y1");
  await finish("x2");
});

test("a canceled queued deploy is skipped by the drain", async () => {
  const { runner, started, finish } = makeFakeRunner();
  __setRunnerForTest(runner);
  await seedServer(db, SRV_A);
  await seedService(db, { id: "svc_x", serverId: SRV_A, status: "queued" });
  await seedService(db, { id: "svc_y", serverId: SRV_A, status: "queued" });
  await seedDeployment(db, { id: "d1", serviceId: "svc_x", serverId: SRV_A, status: "queued", createdAt: "2026-01-01T00:00:01.000Z" });
  await seedDeployment(db, { id: "d2", serviceId: "svc_y", serverId: SRV_A, status: "queued", createdAt: "2026-01-01T00:00:02.000Z" });

  enqueueDeployment({ depId: "d1", serverId: SRV_A, serviceId: "svc_x" });
  enqueueDeployment({ depId: "d2", serverId: SRV_A, serviceId: "svc_y" });
  await waitFor(() => started.length === 1, "d1 started");

  // Cancel d2 while it waits (mimics cancelDeployment's conditional flip).
  await db.update(deploymentsTable).set({ status: "canceled" }).where(eq(deploymentsTable.id, "d2"));

  await finish("d1");
  await settle();
  assert.deepEqual(started, ["d1"], "the canceled deploy is never dispatched");
  assert.equal(await statusOf("d2"), "canceled");
});

test("startDeployQueue re-drains an existing queued backlog on boot", async () => {
  const { runner, started, finish } = makeFakeRunner();
  __setRunnerForTest(runner);
  await seedServer(db, SRV_A);
  await seedService(db, { id: "svc_x", serverId: SRV_A, status: "queued" });
  await seedService(db, { id: "svc_y", serverId: SRV_A, status: "queued" });
  // Rows exist as `queued` (a restart mid-backlog) — nothing enqueued this run.
  await seedDeployment(db, { id: "b1", serviceId: "svc_x", serverId: SRV_A, status: "queued", createdAt: "2026-01-01T00:00:01.000Z" });
  await seedDeployment(db, { id: "b2", serviceId: "svc_y", serverId: SRV_A, status: "queued", createdAt: "2026-01-01T00:00:02.000Z" });

  await startDeployQueue();
  await waitFor(() => started.length === 1, "boot drain started the oldest");
  await settle();
  assert.deepEqual(started, ["b1"], "concurrency 1: only the oldest, in order");
  await finish("b1");
  await waitFor(() => started.length === 2, "second drained after the first finished");
  assert.deepEqual(started, ["b1", "b2"]);
});

test("startDeployQueue backfills a queued row missing its serverId", async () => {
  const { runner, started, finish } = makeFakeRunner();
  __setRunnerForTest(runner);
  await seedServer(db, SRV_A);
  await seedService(db, { id: "svc_x", serverId: SRV_A, status: "queued" });
  // A pre-migration straggler: queued but no denormalized server_id.
  await seedDeployment(db, { id: "old", serviceId: "svc_x", status: "queued" });
  assert.equal(
    (await db.select({ s: deploymentsTable.serverId }).from(deploymentsTable).where(eq(deploymentsTable.id, "old")))[0]?.s,
    null,
  );

  await startDeployQueue();
  await waitFor(() => started.length === 1, "backfilled row got drained");
  assert.deepEqual(started, ["old"]);
  const backfilled = (await db.select({ s: deploymentsTable.serverId }).from(deploymentsTable).where(eq(deploymentsTable.id, "old")))[0]?.s;
  assert.equal(backfilled, SRV_A, "server_id resolved from the owning service");
  await finish("old");
});

test("startDeployment supersedes an older still-queued deploy of the same service", async () => {
  const { runner, started, finish } = makeFakeRunner();
  __setRunnerForTest(runner);
  await seedServer(db, SRV_A);
  await seedService(db, { id: "svc_x", serverId: SRV_A, status: "queued" });
  // An older deploy is already sitting queued (its slot never came free).
  await seedDeployment(db, { id: "old", serviceId: "svc_x", serverId: SRV_A, status: "queued", createdAt: "2026-01-01T00:00:01.000Z" });

  // A new trigger arrives: it must cancel the older queued deploy (supersede) and
  // enqueue the fresh one so the same tree isn't rebuilt twice.
  const fresh = await startDeployment("svc_x", { creator: "Owner", commitMessage: "newer" });

  assert.equal(await statusOf("old"), "canceled", "the older queued deploy is superseded");
  assert.notEqual(fresh, "old");
  await waitFor(() => started.includes(fresh), "the new deploy runs");
  assert.deepEqual(started, [fresh], "only the fresh deploy is dispatched, not the superseded one");
  await finish(fresh);
});

test("deploy_concurrency is clamped to at least 1", async () => {
  const { runner, started, finish } = makeFakeRunner();
  __setRunnerForTest(runner);
  await seedServer(db, SRV_A);
  await setConcurrency(SRV_A, 0); // nonsensical — must clamp to 1, not stall
  await seedService(db, { id: "svc_x", serverId: SRV_A, status: "queued" });
  await seedService(db, { id: "svc_y", serverId: SRV_A, status: "queued" });
  await seedDeployment(db, { id: "c1", serviceId: "svc_x", serverId: SRV_A, status: "queued", createdAt: "2026-01-01T00:00:01.000Z" });
  await seedDeployment(db, { id: "c2", serviceId: "svc_y", serverId: SRV_A, status: "queued", createdAt: "2026-01-01T00:00:02.000Z" });

  enqueueDeployment({ depId: "c1", serverId: SRV_A, serviceId: "svc_x" });
  enqueueDeployment({ depId: "c2", serverId: SRV_A, serviceId: "svc_y" });
  await waitFor(() => started.length === 1, "clamp to 1 still dispatches");
  await settle();
  assert.deepEqual(started, ["c1"], "0 clamped to 1 — serialized, not stalled");
  await finish("c1");
  await waitFor(() => started.length === 2, "drains after finish");
});
