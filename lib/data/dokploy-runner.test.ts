import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DEPLO_DATA_DIR = mkdtempSync(join(tmpdir(), "deplo-runner-"));

import { makeTestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import {
  acquireLease,
  LEASE_STALE_MS,
  __resetLocalLeases,
} from "../backups/lease";
import {
  releaseMigrationRunnerLease,
  runMigrationTick,
} from "./dokploy-runner";

/**
 * The runner's lease, which is the thing that decides whether ANY migration on
 * the instance may move.
 *
 * It went missing from the shutdown list when the runner was added, and its
 * staleness was the schedulers' two hours - so a control plane killed during an
 * import left every migration on that instance frozen until the window aged out,
 * with nothing on screen saying so. Both halves are asserted here because both
 * halves were wrong.
 */

const LEASE = "dokploy-migration-runner";

let harness: Awaited<ReturnType<typeof makeTestDb>>;

before(async () => {
  harness = await makeTestDb();
  __setTestDb(harness.db);
});

after(async () => {
  __resetTestDb();
  await harness.pg.close();
});

beforeEach(() => {
  __resetLocalLeases();
});

test("a tick claims the runner's lease, and shutdown hands it straight back", async () => {
  await runMigrationTick();
  assert.equal(
    await acquireLease(LEASE, "another-instance"),
    false,
    "a live runner must keep a second control plane out",
  );

  await releaseMigrationRunnerLease();

  assert.equal(
    await acquireLease(LEASE, "another-instance"),
    true,
    "a restart must hand the migration over on the next tick, not in two hours",
  );
});

test("a runner that died is taken over in 90s, not in the schedulers' two hours", async () => {
  await runMigrationTick();
  // The dead process never released it: the next control plane can only wait.
  const ninetySeconds = new Date(Date.now() + 91_000);
  assert.equal(
    await acquireLease(LEASE, "successor", ninetySeconds, 90_000),
    true,
  );
  assert.ok(
    LEASE_STALE_MS > 90_000,
    "the point of the shorter window is that it is shorter than the default",
  );
});
