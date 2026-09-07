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
import {
  apps as appsTable,
  envVars as envVarsTable,
} from "../db/schema/control-plane";
import { eq } from "drizzle-orm";
import { upsertEnv, deleteEnv } from "./env";
import { updateAppResources } from "./apps";
import {
  dismissPendingChanges,
  markPendingChangesForSharedVar,
} from "./pending-changes";
import { saveSharedVar, setSharedVarAppLink } from "./shared-vars";

/**
 * The "changes not deployed yet" marker: every write that changes what a deploy
 * would render has to stamp the apps it reaches, and only those.
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

async function pendingAt(appId: string): Promise<string | null> {
  const rows = await db
    .select({ at: appsTable.pendingChangesAt })
    .from(appsTable)
    .where(eq(appsTable.id, appId));
  return rows[0]?.at ?? null;
}

async function clearPending(appId: string): Promise<void> {
  await db
    .update(appsTable)
    .set({ pendingChangesAt: null })
    .where(eq(appsTable.id, appId));
}

test("an env write stamps the app, a delete stamps it again", async () => {
  await seedApp(db, { id: "prj_1", teamId: TEAM_A });
  assert.equal(await pendingAt("prj_1"), null);

  await asUser1(() =>
    upsertEnv({ appId: "prj_1", key: "PORT", value: "3000", type: "plain" }),
  );
  assert.notEqual(await pendingAt("prj_1"), null);

  await clearPending("prj_1");
  const [row] = await db
    .select({ id: envVarsTable.id })
    .from(envVarsTable)
    .where(eq(envVarsTable.appId, "prj_1"));
  await asUser1(() => deleteEnv(row!.id));
  assert.notEqual(await pendingAt("prj_1"), null);
});

test("a setting that only a deploy applies stamps the app", async () => {
  await seedApp(db, { id: "prj_1", teamId: TEAM_A });
  await asUser1(() => updateAppResources("prj_1", { memoryMb: 512 }));
  assert.notEqual(await pendingAt("prj_1"), null);
});

test("a shared var stamps the apps it is linked to, and no others", async () => {
  await seedApp(db, { id: "prj_1", teamId: TEAM_A });
  await seedApp(db, { id: "prj_2", teamId: TEAM_A, slug: "prj-2" });

  const varId = await asUser1(() =>
    saveSharedVar({
      key: "SHARED",
      value: "v1",
      type: "plain",
      teamIds: [TEAM_A],
      environmentIds: [],
      projectIds: [],
      appIds: ["prj_1"],
    }),
  );
  await clearPending("prj_1");
  await clearPending("prj_2");

  await markPendingChangesForSharedVar(varId);
  assert.notEqual(await pendingAt("prj_1"), null);
  // prj_2 never linked it, so its rendered env did not change.
  assert.equal(await pendingAt("prj_2"), null);

  await clearPending("prj_1");
  await asUser1(() => setSharedVarAppLink(varId, "prj_2", true));
  assert.notEqual(await pendingAt("prj_2"), null);
});

test("dismissing clears the stamp, and the next change brings it back", async () => {
  await seedApp(db, { id: "prj_1", teamId: TEAM_A });
  await asUser1(() =>
    upsertEnv({ appId: "prj_1", key: "A", value: "1", type: "plain" }),
  );
  assert.notEqual(await pendingAt("prj_1"), null);

  await asUser1(() => dismissPendingChanges("prj_1"));
  assert.equal(await pendingAt("prj_1"), null);

  await asUser1(() =>
    upsertEnv({ appId: "prj_1", key: "B", value: "2", type: "plain" }),
  );
  assert.notEqual(await pendingAt("prj_1"), null);
});

test("another team's app cannot be dismissed", async () => {
  await seedApp(db, { id: "prj_b", teamId: TEAM_B, slug: "prj-b" });
  await asUser1(async () => {
    await assert.rejects(() => dismissPendingChanges("prj_b"));
  });
});
