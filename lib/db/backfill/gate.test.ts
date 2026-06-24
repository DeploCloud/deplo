import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { count } from "drizzle-orm";

import { __resetLocalLeases } from "../../backups/lease";
import { storeMigration } from "../schema/control-plane";
import { makeTestDb, type TestDb } from "../test-harness";
import { awaitBackfill, type GateTiming } from "./gate";
import { CUT_SETS, markerExists, writeMarker } from "./markers";

/**
 * Step 1 backfill-gate test (relational-store PLAN §7 "Cross-process safety via
 * the scheduler_lease CAS … the backfill needs a real poll-for-marker loop").
 *
 * Under `node --test` the scheduler lease degrades to a globalThis in-process Map
 * (a real mutex within the one process), so the winner/loser logic is exercisable
 * deterministically. Timing is injected (tiny pollMs/heartbeatMs) so the loser's
 * poll loop runs fast.
 */

let db: TestDb;
let pg: PGlite;

const FAST: GateTiming = { pollMs: 5, heartbeatMs: 1_000, deadlineMs: 2_000 };

before(async () => {
  ({ db, pg } = await makeTestDb());
});

after(async () => {
  await pg.close();
});

beforeEach(async () => {
  await pg.exec(`truncate table store_migration restart identity cascade;`);
  __resetLocalLeases();
});

/* ------------------------------------------------------------------ */

test("gate: marker already present ⇒ the runner never runs (fast path)", async () => {
  // Pre-write the marker, then gate: the runner must be skipped entirely.
  await db.transaction(async (tx) =>
    writeMarker(tx, CUT_SETS.leaf),
  );
  let ran = 0;
  await awaitBackfill(db, CUT_SETS.leaf, "owner-1", async () => {
    ran++;
  });
  assert.equal(ran, 0, "runner skipped when marker exists");
});

test("gate: the winner runs the runner exactly once and writes the marker", async () => {
  let ran = 0;
  await awaitBackfill(
    db,
    CUT_SETS.leaf,
    "owner-1",
    async () => {
      ran++;
      // The runner is responsible for writing the marker (the engine does this
      // inside its copy tx); model it here.
      await db.transaction(async (tx) =>
        writeMarker(tx, CUT_SETS.leaf),
      );
    },
    FAST,
  );
  assert.equal(ran, 1);
  assert.equal(await markerExists(db, CUT_SETS.leaf), true);
});

test("gate: a concurrent loser blocks until the winner's marker appears, then returns without re-running", async () => {
  let winnerRuns = 0;
  let loserRuns = 0;

  // The winner holds the lease and runs a slow copy; the loser must block on the
  // poll loop (lease busy) and return only once the marker is written — WITHOUT
  // running its own copy.
  const winner = awaitBackfill(
    db,
    CUT_SETS.leaf,
    "winner",
    async () => {
      winnerRuns++;
      await new Promise((r) => setTimeout(r, 60)); // slow copy
      await db.transaction(async (tx) =>
        writeMarker(tx, CUT_SETS.leaf),
      );
    },
    FAST,
  );

  // Start the loser slightly after so the winner already holds the lease.
  await new Promise((r) => setTimeout(r, 10));
  const loser = awaitBackfill(
    db,
    CUT_SETS.leaf,
    "loser",
    async () => {
      loserRuns++;
    },
    FAST,
  );

  await Promise.all([winner, loser]);

  assert.equal(winnerRuns, 1, "winner ran the copy once");
  assert.equal(loserRuns, 0, "loser blocked on the marker and never re-ran the copy");
  assert.equal((await db.select({ n: count() }).from(storeMigration))[0]!.n, 1);
});

test("gate: a runner throw propagates and leaves no marker (so the next boot retries)", async () => {
  await assert.rejects(
    () =>
      awaitBackfill(
        db,
        CUT_SETS.leaf,
        "owner-1",
        async () => {
          throw new Error("reconcile mismatch: boom");
        },
        FAST,
      ),
    /reconcile mismatch/,
  );
  assert.equal(await markerExists(db, CUT_SETS.leaf), false);

  // The lease was released in the winner's finally, so a fresh attempt can win.
  let ran = 0;
  await awaitBackfill(
    db,
    CUT_SETS.leaf,
    "owner-2",
    async () => {
      ran++;
      await db.transaction(async (tx) =>
        writeMarker(tx, CUT_SETS.leaf),
      );
    },
    FAST,
  );
  assert.equal(ran, 1, "the lease was freed, so a retry can acquire and run");
  assert.equal(await markerExists(db, CUT_SETS.leaf), true);
});
