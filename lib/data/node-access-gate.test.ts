import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { PGlite } from "@electric-sql/pglite";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import {
  folderGrants as folderGrantsTable,
  folders as foldersTable,
} from "../db/schema/control-plane";
import { runWithIdentity } from "../auth/request-context";
import { seedIdentity, TEAM_A } from "./identity-test-helpers";
import { seedApp, seedServer } from "./app-graph-test-helpers";
import { listAllAppEnv, listEnv, upsertEnv } from "./env";
import { deleteSharedVar, revealSharedVar, saveSharedVar } from "./shared-vars";
import type { Capability } from "../types";

/**
 * The gate, end to end: `requireAppCapability` is what makes an override usable,
 * and what keeps it from becoming team-wide.
 *
 * DEV's role gives `view` and nothing else. A folder grant of `manage_env` on
 * Prod must be enough to edit the variables of an app in Prod — that is the
 * feature — and must be enough for NOTHING else: not another app, not the team's
 * shared-variable library, not the aggregate Variables tab beyond the one app.
 * Those are the exact leaks that ruled out widening `membershipFor` instead.
 */

let db: TestDb;
let pg: PGlite;

const T0 = "2026-01-01T00:00:00.000Z";
const ADMIN = "u_admin";
const DEV = "u_dev";
const FLD_PROD = "fld_prod";
const APP_IN_PROD = "prj_in_prod";
const APP_ELSEWHERE = "prj_elsewhere";

const as = <T>(userId: string, fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId, teamId: TEAM_A }, fn);

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
});

after(async () => {
  __resetTestDb();
  await pg.close();
});

beforeEach(async () => {
  await pg.exec(`truncate table
    app_grants, folder_grants, project_grants, shared_env_var_apps, shared_env_var_targets, shared_env_vars,
    env_var_targets, env_vars,
    app_build_method_settings, app_build, apps, folders, projects, servers,
    membership_capabilities, memberships, users, teams restart identity cascade;`);
  await seedIdentity(db, {
    users: [
      { id: ADMIN, teamId: TEAM_A, role: "owner" },
      {
        id: DEV,
        teamId: TEAM_A,
        role: "member",
        isInstanceAdmin: false,
        capabilities: ["view"] as Capability[],
      },
    ],
  });
  await seedServer(db);
  await db.insert(foldersTable).values({
    id: FLD_PROD,
    teamId: TEAM_A,
    name: "Prod",
    parentId: null,
    color: null,
    ownerUserId: ADMIN,
    projectId: null,
    createdAt: T0,
    updatedAt: T0,
  });
  await seedApp(db, { id: APP_IN_PROD, teamId: TEAM_A, folderId: FLD_PROD });
  await seedApp(db, { id: APP_ELSEWHERE, teamId: TEAM_A });
  // The whole grant: manage_env on Prod, and nothing at the team level.
  await db
    .insert(folderGrantsTable)
    .values({ folderId: FLD_PROD, userId: DEV, capability: "manage_env" });
});

test("a folder grant is enough to write the variables of an app in that folder", async () => {
  await as(DEV, () =>
    upsertEnv({
      appId: APP_IN_PROD,
      key: "DATABASE_URL",
      value: "postgres://x",
      type: "secret",
    }),
  );
  const vars = await as(DEV, () => listEnv(APP_IN_PROD));
  assert.deepEqual(
    vars.map((v) => v.key),
    ["DATABASE_URL"],
  );
});

test("and is enough for nothing else: another app is refused and invisible", async () => {
  await as(DEV, async () => {
    await assert.rejects(
      () =>
        upsertEnv({
          appId: APP_ELSEWHERE,
          key: "SNEAKY",
          value: "1",
          type: "plain",
        }),
      /not found|permission/i,
    );
    assert.deepEqual(await listEnv(APP_ELSEWHERE), []);
  });
});

test("the team's shared-variable library stays closed to a node-only holder", async () => {
  const varId = await as(ADMIN, () =>
    saveSharedVar({
      key: "STRIPE_KEY",
      value: "sk_live_secret",
      type: "secret",
      teamWide: true,
      environmentIds: [],
      projectIds: [],
    }),
  );
  await as(DEV, async () => {
    // Both of these read or destroy a TEAM resource with no node dimension, so
    // they stay behind the team capability however many folders you hold.
    await assert.rejects(() => revealSharedVar(varId), /permission/i);
    await assert.rejects(() => deleteSharedVar(varId), /permission/i);
  });
});

test("the aggregate Variables tab shows the granted app and no other", async () => {
  await as(ADMIN, () =>
    upsertEnv({ appId: APP_ELSEWHERE, key: "OTHER", value: "1", type: "plain" }),
  );
  await as(DEV, () =>
    upsertEnv({ appId: APP_IN_PROD, key: "MINE", value: "1", type: "plain" }),
  );
  const groups = await as(DEV, () => listAllAppEnv());
  assert.deepEqual(
    groups.map((g) => g.app.id),
    [APP_IN_PROD],
    "a top-level app is no longer waved through for a folder-only holder",
  );
});
