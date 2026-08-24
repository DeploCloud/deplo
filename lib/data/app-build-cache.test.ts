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
import { updateAppBuild, clearAppBuildCache } from "./apps";
import { loadAppGraph } from "./app-graph-load";
import { noCacheForDeploy, consumeCacheClear } from "../deploy/build";

/**
 * The per-app build cache: the stored setting, the one-shot "Clear build cache",
 * and the two ways they must not interfere with each other.
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

test("an app builds WITH the cache until someone says otherwise", async () => {
  await seedApp(db, { id: "prj_1", teamId: TEAM_A });
  const app = await loadAppGraph("prj_1");
  assert.equal(app?.build.buildCache, true);
  assert.equal(app?.build.buildCacheClearPending, false);
});

test("the Build cache switch round-trips", async () => {
  await seedApp(db, { id: "prj_1", teamId: TEAM_A });
  await asUser1(() => updateAppBuild("prj_1", { buildCache: false }));
  assert.equal((await loadAppGraph("prj_1"))?.build.buildCache, false);
  await asUser1(() => updateAppBuild("prj_1", { buildCache: true }));
  assert.equal((await loadAppGraph("prj_1"))?.build.buildCache, true);
});

test("saving other build settings leaves the cache setting alone", async () => {
  await seedApp(db, { id: "prj_1", teamId: TEAM_A });
  await asUser1(async () => {
    await updateAppBuild("prj_1", { buildCache: false });
    // The Build & Output card's Save sends its own fields only.
    await updateAppBuild("prj_1", { buildCommand: "npm run build" });
  });
  const app = await loadAppGraph("prj_1");
  assert.equal(
    app?.build.buildCache,
    false,
    "a build save clobbered the cache setting",
  );
  assert.equal(app?.build.buildCommand, "npm run build");
});

test("Clear build cache arms the one-shot, and a build save can't swallow it", async () => {
  await seedApp(db, { id: "prj_1", teamId: TEAM_A });
  await asUser1(async () => {
    await clearAppBuildCache("prj_1");
    assert.equal(
      (await loadAppGraph("prj_1"))?.build.buildCacheClearPending,
      true,
    );
    // Someone edits the build settings before deploying: the armed clear must
    // survive it (updateAppBuild merges field-by-field and never writes it).
    await updateAppBuild("prj_1", { installCommand: "npm ci" });
  });
  const app = await loadAppGraph("prj_1");
  assert.equal(app?.build.buildCacheClearPending, true);
  assert.equal(app?.build.installCommand, "npm ci");
});

test("clearing twice before a deploy is still one armed clear", async () => {
  await seedApp(db, { id: "prj_1", teamId: TEAM_A });
  await asUser1(async () => {
    await clearAppBuildCache("prj_1");
    await clearAppBuildCache("prj_1");
  });
  assert.equal(
    (await loadAppGraph("prj_1"))?.build.buildCacheClearPending,
    true,
  );
});

test("another team's app cannot be touched", async () => {
  await seedApp(db, { id: "prj_other", teamId: TEAM_B });
  await asUser1(async () => {
    await assert.rejects(
      () => clearAppBuildCache("prj_other"),
      /App not found/,
    );
    await assert.rejects(
      () => updateAppBuild("prj_other", { buildCache: false }),
      /App not found/,
    );
  });
  // …and nothing about it moved.
  const app = await loadAppGraph("prj_other");
  assert.equal(app?.build.buildCache, true);
  assert.equal(app?.build.buildCacheClearPending, false);
});

/* ---- what a deploy does with all this ------------------------------- */

test("the deploy decides no-cache from the setting OR the armed clear", () => {
  assert.equal(
    noCacheForDeploy({ buildCache: true, buildCacheClearPending: false })
      .noCache,
    false,
  );
  const off = noCacheForDeploy({
    buildCache: false,
    buildCacheClearPending: false,
  });
  assert.equal(off.noCache, true);
  assert.match(off.reason, /off for this app/);
  // An armed clear beats the setting, and says so — "why was this build slow"
  // has two different answers and the log must not blur them.
  const cleared = noCacheForDeploy({
    buildCache: true,
    buildCacheClearPending: true,
  });
  assert.equal(cleared.noCache, true);
  assert.match(cleared.reason, /cleared/i);
});

test("a build spends the one-shot, so the next deploy caches again", async () => {
  await seedApp(db, { id: "prj_1", teamId: TEAM_A });
  await asUser1(() => clearAppBuildCache("prj_1"));
  assert.equal(
    (await loadAppGraph("prj_1"))?.build.buildCacheClearPending,
    true,
  );
  await consumeCacheClear("prj_1");
  const after = (await loadAppGraph("prj_1"))!.build;
  assert.equal(after.buildCacheClearPending, false);
  assert.equal(
    after.buildCache,
    true,
    "spending the one-shot must not turn the cache off",
  );
  // Idempotent: a second deploy consuming nothing is a no-op, not an error.
  await consumeCacheClear("prj_1");
  assert.equal(
    (await loadAppGraph("prj_1"))?.build.buildCacheClearPending,
    false,
  );
});
