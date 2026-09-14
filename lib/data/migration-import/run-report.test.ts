import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { makeTestDb, type TestDb } from "../../db/test-harness";
import { eq } from "drizzle-orm";
import { markDataCopyFailed } from "../data-copy";
import { recopySourceFor } from "../migration-data/recopy";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import { migrationRunItems as itemsTable } from "../../db/schema/control-plane/migration";
import { TEAM_A } from "../identity-test-helpers";
import { seedApp } from "../app-graph-test-helpers";
import { importMigrationProject } from "./project-import";
import { beginMigration, finishMigration } from "./run-lifecycle";
import { getMigrationRun } from "./run-queries";
import { appendRunItem, sweepFinishedMigrationMarks } from "./run-report";
import {
  URL_BASE,
  CONNECT,
  asOwner,
  importProject,
  openMigrationHarness,
  closeMigrationHarness,
  resetMigrationHarness,
} from "./migration-import-test-helpers";

let db: TestDb;
let pg: PGlite;

before(async () => {
  ({ db, pg } = await makeTestDb());
  await openMigrationHarness(db);
});

after(() => closeMigrationHarness(db, pg));

beforeEach(() => resetMigrationHarness(db));

test("a report row about the panel itself names the panel", async () => {
  const runId = await asOwner(() => beginMigration({ url: URL_BASE }));
  await asOwner(() =>
    importMigrationProject({
      ...CONNECT,
      runId,
      projectId: "dok-prj-blink",
      servers: [{ from: "", to: "srv_not_ours" }],
    }),
  );

  const row = (await asOwner(() => getMigrationRun(runId)))!.items.find(
    (i) => i.sourceKind === "server",
  )!;
  assert.equal(row.sourceName, "the Dokploy host");
});

test("a blocked app can say where its data still is", async () => {
  const runId = await asOwner(() => beginMigration({ url: URL_BASE }));
  await importProject(runId, "dok-prj-blink");
  await asOwner(() => finishMigration(runId));
  const web = (await db.select().from(appsTable)).find(
    (a) => a.name === "blink-web",
  )!;

  const from = await asOwner(() => recopySourceFor("app", web.id));
  assert.equal(from?.runId, runId);
  assert.equal(from?.sourceId, "dok-app-web");
  assert.equal(from?.sourceKind, "application");
  assert.equal(from?.sourceUrl, URL_BASE);
  assert.equal(from?.platform, "dokploy");

  await seedApp(db, { id: "prj_handmade", teamId: TEAM_A, slug: "handmade" });
  assert.equal(
    await asOwner(() => recopySourceFor("app", "prj_handmade")),
    null,
  );
});

test("a line written after the run is over does not freeze the app", async () => {
  const runId = await asOwner(() => beginMigration({ url: URL_BASE }));
  await importProject(runId, "dok-prj-blink");
  await asOwner(() => finishMigration(runId));
  const web = (await db.select().from(appsTable)).find(
    (a) => a.name === "blink-web",
  )!;
  assert.equal(web.migrationRunId, null, "the finish handed it back");

  await appendRunItem(runId, "Dokploy", {
    path: "Blink / production / blink-web",
    sourceKind: "volume",
    sourceName: "blink-web-abc_uploads",
    outcome: "created",
    targetKind: "app",
    targetId: web.id,
    message: "Copied 12 MB (compressed) into deplo-blink-web-uploads.",
  });

  const after = (await db.select().from(appsTable)).find(
    (a) => a.id === web.id,
  )!;
  assert.equal(after.migrationRunId, null, "and it stays handed back");
});

test("the same advice is not written into one report twice", async () => {
  const runId = await asOwner(() => beginMigration({ url: URL_BASE }));
  const advice = {
    path: "Blink / production / blink-web",
    sourceKind: "data",
    sourceName: "blink-web",
    message:
      'The compose file mounts "shared-vol" at /data, but {panel} ignored that.',
  };
  await appendRunItem(runId, "Dokploy", { ...advice, outcome: "manual" });
  await appendRunItem(runId, "Dokploy", { ...advice, outcome: "manual" });
  await appendRunItem(runId, "Dokploy", {
    ...advice,
    path: "Blink / production / blink-api",
    outcome: "manual",
  });
  await appendRunItem(runId, "Dokploy", { ...advice, outcome: "skipped" });
  await appendRunItem(runId, "Dokploy", { ...advice, outcome: "skipped" });

  const rows = await db.select().from(itemsTable);
  assert.equal(
    rows.filter((r) => r.outcome === "manual").length,
    2,
    "one line per subject, not one per read of the panel",
  );
  assert.equal(
    rows.filter((r) => r.outcome === "skipped").length,
    2,
    "an outcome is a fact and is never folded away",
  );
  assert.match(
    rows.find((r) => r.outcome === "manual")!.message!,
    /Dokploy ignored that/,
    "the placeholder is resolved before the comparison, not after",
  );
});

test("a stumble on a retry does not blank out a copy that landed", async () => {
  const runId = await asOwner(() => beginMigration({ url: URL_BASE }));
  await importProject(runId, "dok-prj-blink");
  const web = (await db.select().from(appsTable)).find(
    (a) => a.name === "blink-web",
  )!;
  const errorOf = async () =>
    (await db.select().from(appsTable)).find((a) => a.id === web.id)!
      .dataCopyError;

  await markDataCopyFailed({ kind: "app", id: web.id }, "the panel stumbled", {
    unlessCopiedIn: runId,
  });
  assert.equal(await errorOf(), "the panel stumbled");

  await db
    .update(appsTable)
    .set({ dataCopyError: "" })
    .where(eq(appsTable.id, web.id));
  await appendRunItem(runId, "Dokploy", {
    path: "Blink / production / blink-web",
    sourceKind: "volume",
    sourceName: "blink-web-abc_uploads",
    outcome: "created",
    targetKind: "app",
    targetId: web.id,
    message: "Copied 12 MB (compressed) into deplo-blink-web-uploads.",
  });

  await markDataCopyFailed({ kind: "app", id: web.id }, "the panel stumbled", {
    unlessCopiedIn: runId,
  });
  assert.equal(await errorOf(), "");
});

test("the sweep frees a row whose migration is over", async () => {
  const runId = await asOwner(() => beginMigration({ url: URL_BASE }));
  await importProject(runId, "dok-prj-blink");
  await asOwner(() => finishMigration(runId));
  const web = (await db.select().from(appsTable)).find(
    (a) => a.name === "blink-web",
  )!;
  await db
    .update(appsTable)
    .set({ migrationRunId: runId })
    .where(eq(appsTable.id, web.id));

  await sweepFinishedMigrationMarks();

  const after = (await db.select().from(appsTable)).find(
    (a) => a.id === web.id,
  )!;
  assert.equal(after.migrationRunId, null);
});
