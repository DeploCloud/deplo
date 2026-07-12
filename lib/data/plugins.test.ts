import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { installedApps as installedAppsTable } from "../db/schema/control-plane";
import { runWithIdentity } from "../auth/request-context";
import { seedIdentity, TEAM_A, TEAM_B, USER_1 } from "./leaf-test-helpers";
import { appRuntimeStatus, startApp, stopApp } from "./apps";

/**
 * Data-layer tests for `installed_apps` against pglite (PLAN Step 2). These
 * exercise the async Drizzle READ + team-scoping path. The install/uninstall
 * mutations and `listInstalledApps` go through the app runtime (Docker) and
 * `headers()` (a request scope) so they aren't unit-testable here — that was true
 * of the JSONB version too. The migration-relevant change (the team-scoped
 * `findApp` query + the "App not installed" guard) is fully covered:
 *  - `appRuntimeStatus` resolves an existing row (status "error" — no Docker — is
 *    the honest answer when the daemon is unreachable),
 *  - `startApp`/`stopApp` reject a row that isn't in the caller's active team
 *    BEFORE touching the runtime (the team-scoped find returns null).
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
  await pg.exec(
    `truncate table installed_apps, users, teams restart identity cascade;`,
  );
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      { id: "user_2", teamId: TEAM_B, role: "owner" },
    ],
  });
});

const asUser1 = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);

async function seedApp(id: string, teamId: string, slug: string): Promise<void> {
  await db.insert(installedAppsTable).values({
    id,
    teamId,
    catalogId: "mcp",
    slug,
    version: "1.0.0",
    createdAt: "2026-02-01T00:00:00.000Z",
  });
}

test("appRuntimeStatus reads an existing app in the active team (error without Docker)", async () => {
  await seedApp("app_1", TEAM_A, "mcp__alpha");
  await asUser1(async () => {
    assert.equal(await appRuntimeStatus("app_1"), "error");
  });
});

test("appRuntimeStatus rejects an app the active team does not own", async () => {
  await seedApp("app_b", TEAM_B, "mcp__beta");
  await asUser1(async () => {
    await assert.rejects(() => appRuntimeStatus("app_b"), /App not installed/);
  });
});

test("startApp / stopApp reject a cross-team app before touching the runtime", async () => {
  await seedApp("app_b", TEAM_B, "mcp__beta");
  await asUser1(async () => {
    // Team-scoped find returns null → "App not installed" before any docker call.
    await assert.rejects(() => startApp("app_b"), /App not installed/);
    await assert.rejects(() => stopApp("app_b"), /App not installed/);
  });
});
