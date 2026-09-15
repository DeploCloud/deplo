import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../../db/test-harness";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import {
  migrationRuns as runsTable,
  migrationRunTargets as targetsTable,
} from "../../db/schema/control-plane/migration";
import { encryptSecret } from "../../crypto";
import { newId } from "../../ids";
import { USER_1 } from "../identity-test-helpers";
import { settleProvisioning } from "../backup-test-helpers";
import { __setMigrationFetchForTest } from "../../migration/transport";
import {
  CONNECT,
  URL_BASE,
  importProject,
  source,
  asOwner,
  closeMigrationHarness,
  openMigrationHarness,
  resetMigrationHarness,
  routingFetch,
} from "../migration-import/migration-import-test-helpers";
import { beginMigration } from "../migration-import/run-lifecycle";
import { runConfigPhase } from "./config-phase";
import { stopped } from "./stop";

let db: TestDb;
let pg: PGlite;

before(async () => {
  ({ db, pg } = await makeTestDb());
  await openMigrationHarness(db);
});

after(() => closeMigrationHarness(db, pg));

beforeEach(() => resetMigrationHarness(db));

async function seedRunWithOneProject(): Promise<string> {
  const runId = await asOwner(() => beginMigration({ url: URL_BASE }));
  await db
    .update(runsTable)
    .set({
      apiKeyEnc: encryptSecret(CONNECT.apiKey),
      actorUserId: USER_1,
      totalSteps: 1,
    })
    .where(eq(runsTable.id, runId));
  await db.insert(targetsTable).values({
    id: newId("dtgt"),
    runId,
    projectId: "dok-prj-blink",
    projectName: "Blink",
    serviceId: "dok-app-web",
  });
  return runId;
}

function stopWhileImporting(runId: string): void {
  const base = routingFetch();
  let armed = true;
  __setMigrationFetchForTest(async (input: string, init?: RequestInit) => {
    const res = await base(input, init);
    if (armed && input.includes("application.one")) {
      armed = false;
      await db
        .update(runsTable)
        .set({ stopRequested: true })
        .where(eq(runsTable.id, runId));
    }
    return res;
  });
}

test("a stop asked while the last project imports still undoes the run", async () => {
  const runId = await seedRunWithOneProject();
  stopWhileImporting(runId);

  const [row] = await db
    .select()
    .from(runsTable)
    .where(eq(runsTable.id, runId));
  await asOwner(() =>
    runConfigPhase(row, {
      kind: "dokploy",
      url: URL_BASE,
      apiKey: CONNECT.apiKey,
    }),
  );
  await asOwner(() => stopped(runId));
  await settleProvisioning(db);

  const [after] = await db
    .select()
    .from(runsTable)
    .where(eq(runsTable.id, runId));
  assert.equal(
    (await db.select().from(appsTable)).length,
    0,
    "Stop promises the undo, so nothing the config step created may survive it",
  );
  assert.equal(after.status, "reverted");
});

test("a stop asked during the data step undoes it too, and puts the source back", async () => {
  const runId = await seedRunWithOneProject();
  await importProject(runId, "dok-prj-blink");
  await settleProvisioning(db);
  assert.ok(
    (await db.select().from(appsTable)).length > 0,
    "the import has to have made something to undo",
  );

  source.fixtures["application.start"] = { ok: true };
  await db
    .update(targetsTable)
    .set({ stoppedAt: new Date().toISOString(), stoppedKind: "application" })
    .where(eq(targetsTable.runId, runId));
  await db
    .update(runsTable)
    .set({ phase: "data", stopRequested: true })
    .where(eq(runsTable.id, runId));

  await asOwner(() => stopped(runId));
  await settleProvisioning(db);

  const [after] = await db
    .select()
    .from(runsTable)
    .where(eq(runsTable.id, runId));
  assert.equal(
    (await db.select().from(appsTable)).length,
    0,
    "Stop says it removes what the run created, in every phase",
  );
  assert.equal(after.status, "reverted");
  assert.ok(
    source.calls.includes("application.start"),
    "what the run stopped on the panel has to be running again",
  );
});
