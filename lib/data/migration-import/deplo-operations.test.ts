import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { makeTestDb, type TestDb } from "../../db/test-harness";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import type { DeploExportApp } from "../../migration/deplo/export-shape";
import {
  deploExport,
  exportApp,
} from "../../migration/deplo/deplo-test-helpers";
import {
  closeMigrationHarness,
  openMigrationHarness,
  provisionServer1,
  resetMigrationHarness,
} from "./migration-import-test-helpers";
import {
  blockingLines,
  importFromDeplo,
  reportLines,
} from "./deplo-import-test-helpers";

let db: TestDb;
let pg: PGlite;

before(async () => {
  ({ db, pg } = await makeTestDb());
  await openMigrationHarness(db);
});

after(() => closeMigrationHarness(db, pg));

beforeEach(async () => {
  await resetMigrationHarness(db);
  await provisionServer1(db);
});

const landed = async (name: string) =>
  (await db.select().from(appsTable)).find((a) => a.name === name)!;

const stack = (over: Partial<DeploExportApp> = {}) =>
  exportApp({
    id: "prj_stack",
    name: "stack",
    slug: "stack",
    source: "compose",
    repo: null,
    compose: "services:\n  web:\n    image: nginx:1.27\n",
    ...over,
  });

test("a stack lands with its compose flags, rollback count and deploy hook as they were", async () => {
  const runId = await importFromDeplo(
    deploExport({
      apps: [
        stack({
          composeUpArgs: "--remove-orphans --wait",
          rollbackKeep: 9,
          deployHook: { enabled: false, used: false },
        }),
      ],
      databases: [],
    }),
    ["prc_shop"],
  );

  const app = await landed("stack");
  assert.equal(app.composeUpArgs, "--remove-orphans --wait");
  assert.equal(app.rollbackKeep, 9);
  assert.equal(app.deployHookEnabled, false);
  const lines = (await reportLines(runId)).join(" | ");
  assert.doesNotMatch(lines, /too old/);
  assert.doesNotMatch(lines, /deploy hook/i);
});

test("a deploy hook somebody called says its address changed, without blocking the app", async () => {
  const runId = await importFromDeplo(
    deploExport({
      apps: [
        stack({
          composeUpArgs: null,
          rollbackKeep: 3,
          deployHook: { enabled: true, used: true },
        }),
      ],
      databases: [],
    }),
    ["prc_shop"],
  );

  assert.equal((await landed("stack")).deployHookEnabled, true);
  assert.match(
    (await reportLines(runId)).join(" | "),
    /deploy hook has a new address here/,
  );
  assert.doesNotMatch((await blockingLines(runId)).join(" | "), /deploy hook/);
});

test("a Deplo too old to send them says the deploy settings start at the defaults", async () => {
  const runId = await importFromDeplo(
    deploExport({ apps: [stack()], databases: [] }),
    ["prc_shop"],
  );

  const app = await landed("stack");
  assert.equal(app.composeUpArgs, null);
  assert.equal(app.rollbackKeep, 3);
  assert.match(
    (await reportLines(runId)).join(" | "),
    /too old to hand over its compose flags, rollback count and deploy hook/,
  );
});
