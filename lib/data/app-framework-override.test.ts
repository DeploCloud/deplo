import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PGlite } from "@electric-sql/pglite";

process.env.DEPLO_DATA_DIR = mkdtempSync(join(tmpdir(), "deplo-pg-"));

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { runWithIdentity } from "../auth/request-context";
import { seedIdentity, TEAM_A, TEAM_B, USER_1 } from "./identity-test-helpers";
import {
  seedServer,
  seedApp,
  TRUNCATE_PROJECT_GRAPH,
} from "./app-graph-test-helpers";
import { setAppFramework } from "./apps";
import { loadAppGraph } from "./app-graph-load";
import { effectiveFramework } from "../apps/framework-catalog";

/**
 * Correcting the framework Deplo detected. The whole point of the feature is
 * that the correction OUTLIVES detection — a deploy re-reads the source on every
 * push, and that write must not take the user's answer with it.
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

beforeEach(async () => {
  await pg.exec(`${TRUNCATE_PROJECT_GRAPH}
    truncate table users, teams restart identity cascade;`);
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      { id: "user_2", teamId: TEAM_B, role: "owner" },
    ],
  });
  await seedServer(db);
});

const asUser1 = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);

/** What a deploy's re-detection writes: the `framework` column, and only it. */
const detect = (id: string, framework: string) =>
  pg.exec(`update apps set framework = '${framework}' where id = '${id}'`);

test("an app trusts detection until someone corrects it", async () => {
  await seedApp(db, { id: "prj_1", teamId: TEAM_A });
  await detect("prj_1", "nextjs");
  const app = (await loadAppGraph("prj_1"))!;
  assert.equal(app.framework, "nextjs");
  assert.equal(app.frameworkOverride, null);
  assert.equal(effectiveFramework(app), "nextjs");
});

test("the correction wins, and a later deploy's detection does not undo it", async () => {
  await seedApp(db, { id: "prj_1", teamId: TEAM_A });
  await detect("prj_1", "nextjs");
  await asUser1(() => setAppFramework("prj_1", "vite"));

  const corrected = (await loadAppGraph("prj_1"))!;
  assert.equal(effectiveFramework(corrected), "vite");
  // Detection's own answer is still on the row — that is what lets the UI say
  // "we detected Next.js" beside the user's Vite.
  assert.equal(corrected.framework, "nextjs");

  // The next push re-detects Next.js all over again. The choice must survive.
  await detect("prj_1", "nextjs");
  const afterDeploy = (await loadAppGraph("prj_1"))!;
  assert.equal(effectiveFramework(afterDeploy), "vite");
});

test("clearing the correction goes back to what deplo detects", async () => {
  await seedApp(db, { id: "prj_1", teamId: TEAM_A });
  await detect("prj_1", "nextjs");
  await asUser1(() => setAppFramework("prj_1", "vite"));
  await asUser1(() => setAppFramework("prj_1", null));

  const app = (await loadAppGraph("prj_1"))!;
  assert.equal(app.frameworkOverride, null);
  assert.equal(effectiveFramework(app), "nextjs");
});

test("a framework id the catalog doesn't know is refused, not stored", async () => {
  await seedApp(db, { id: "prj_1", teamId: TEAM_A });
  await assert.rejects(
    () => asUser1(() => setAppFramework("prj_1", "laravel")),
    /Unknown framework/,
  );
  assert.equal((await loadAppGraph("prj_1"))?.frameworkOverride, null);
});

test("another team's app cannot be corrected", async () => {
  await seedApp(db, { id: "prj_other", teamId: TEAM_B });
  await assert.rejects(
    () => asUser1(() => setAppFramework("prj_other", "vite")),
    /not found/i,
  );
  assert.equal((await loadAppGraph("prj_other"))?.frameworkOverride, null);
});
