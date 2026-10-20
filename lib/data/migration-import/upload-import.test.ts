import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import type { PGlite } from "@electric-sql/pglite";
import { makeTestDb, type TestDb } from "../../db/test-harness";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import {
  deploExport,
  exportApp,
} from "../../migration/deplo/deplo-test-helpers";
import type { DeploExportApp } from "../../migration/deplo/export-shape";
import {
  closeMigrationHarness,
  openMigrationHarness,
  resetMigrationHarness,
} from "./migration-import-test-helpers";
import {
  fakeDeplo,
  importDeploProject,
  reportLines,
} from "./deplo-import-test-helpers";

let db: TestDb;
let pg: PGlite;

before(async () => {
  ({ db, pg } = await makeTestDb());
  await openMigrationHarness(db);
});

after(() => closeMigrationHarness(db, pg));

beforeEach(() => resetMigrationHarness(db));

const ARCHIVE = "pretend this is a tarball";

function uploadApp(over: Partial<DeploExportApp> = {}): DeploExportApp {
  return exportApp({
    id: "prj_site",
    name: "site",
    slug: "site",
    source: "upload",
    repo: null,
    upload: {
      filename: "site.tar.gz",
      size: ARCHIVE.length,
      uploadedAt: "2026-10-01T00:00:00.000Z",
    },
    ...over,
  });
}

const landed = async () =>
  (await db.select().from(appsTable)).find((a) => a.name === "site")!;

test("an app deployed from an uploaded archive comes across with that archive", async () => {
  const source = fakeDeplo(
    deploExport({ apps: [uploadApp()], databases: [] }),
    (body) =>
      body.upload === true && body.id === "prj_site"
        ? new Response(ARCHIVE, { status: 200 })
        : new Response("not found", { status: 404 }),
  );
  const runId = await importDeploProject("prc_shop");

  const app = await landed();
  assert.equal(app.source, "upload");
  assert.equal(app.uploadFilename, "site.tar.gz");
  assert.equal(await readFile(app.uploadPath!, "utf8"), ARCHIVE);
  assert.ok(source.asked.some((b) => b.upload === true));
  const lines = (await reportLines(runId)).join(" | ");
  assert.doesNotMatch(lines, /upload/i);
});

test("an archive the old Deplo will not hand over leaves the app asking for a fresh upload", async () => {
  fakeDeplo(
    deploExport({ apps: [uploadApp()], databases: [] }),
    () => new Response("boom", { status: 500 }),
  );
  const runId = await importDeploProject("prc_shop");

  const app = await landed();
  assert.equal(app.source, "upload");
  assert.equal(app.uploadPath, null);
  const lines = (await reportLines(runId)).join(" | ");
  assert.match(lines, /site\.tar\.gz could not be copied/);
  assert.match(lines, /Upload it again/);
});

test("a Deplo too old to name its archive says the app needs a fresh upload", async () => {
  const source = fakeDeplo(
    deploExport({ apps: [uploadApp({ upload: undefined })], databases: [] }),
  );
  const runId = await importDeploProject("prc_shop");

  assert.equal((await landed()).uploadPath, null);
  assert.equal(source.asked.length, 0);
  const lines = (await reportLines(runId)).join(" | ");
  assert.match(lines, /too old to hand over its uploaded archive/);
  assert.doesNotMatch(lines, /the API will not hand the file over/);
});

test("an upload app with no archive on the old Deplo says there was nothing to bring", async () => {
  fakeDeplo(
    deploExport({ apps: [uploadApp({ upload: null })], databases: [] }),
  );
  const runId = await importDeploProject("prc_shop");

  assert.equal((await landed()).uploadPath, null);
  const lines = (await reportLines(runId)).join(" | ");
  assert.match(lines, /had no archive uploaded/);
});
