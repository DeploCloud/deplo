import {
  asOwner,
  CONNECT,
  closeHarness,
  openHarness,
  openRun,
  resetHarness,
  seedMigrationHostServer,
  state,
} from "../migration-data/migration-data-test-helpers";

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { eq } from "drizzle-orm";

import type { TestDb } from "../../db/test-harness";
import { migrationRuns as runsTable } from "../../db/schema/control-plane/migration";
import { runDataPhase } from "./data-phase";

let db: TestDb;

before(async () => {
  db = await openHarness();
});

after(closeHarness);

beforeEach(resetHarness);

test("a service whose copy failed is in the run's summary, not only on its own line", async () => {
  await seedMigrationHostServer();
  state.notFoundVolumes.add("blink-web-abc_uploads");
  const runId = await openRun();
  const [row] = await db
    .select()
    .from(runsTable)
    .where(eq(runsTable.id, runId));

  await asOwner(() =>
    runDataPhase(row, { kind: "dokploy", ...CONNECT }).catch(() => {}),
  );

  const summary = await db.execute(
    `select message from migration_run_items where run_id = '${runId}' and source_kind = 'run'`,
  );
  assert.match(
    String(summary.rows[0]?.message),
    /could not have their data cut over/,
    JSON.stringify(summary.rows),
  );
});
