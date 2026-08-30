// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import {
  folders as foldersTable,
  apps as appsTable,
  appMounts as appMountsTable,
} from "../db/schema/control-plane";
import { runWithIdentity } from "../auth/request-context";
import { seedIdentity, TEAM_A } from "./identity-test-helpers";
import { seedApp, seedServer } from "./app-graph-test-helpers";
import { setFolderGrant } from "./folder-access";
import { writeAppFile, readAppStorageFile } from "./app-files";
import { __setAgentConnectorForTest } from "../infra/agent-client";

/**
 * A File volume's body is written under `configure_apps` - per team and per folder
 * grant, at the data layer, not only at the field's authScopes.
 */

let db: TestDb;
let pg: PGlite;

const T0 = "2026-01-01T00:00:00.000Z";
const OWNER = "u_owner";
const MEMBER = "u_member";
const GRANTEE = "u_grantee";
const FLD = "fld_secret";
const PRJ_IN = "prj_in_folder";
const PRJ_TOP = "prj_top_level";

const writes: string[] = [];

const as = <T>(userId: string, fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId, teamId: TEAM_A }, fn);

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
  __setAgentConnectorForTest(
    async () =>
      ({
        writeFile: async (_s: string, p: string) => {
          writes.push(p);
          return {
            path: p,
            name: p,
            kind: "file",
            size: 1,
            modifiedAt: T0,
          };
        },
        readFile: async (_s: string, p: string) => ({
          path: p,
          text: "x",
          size: 1,
          reason: null,
        }),
        close: () => {},
      }) as unknown as Awaited<
        ReturnType<typeof import("../infra/agent-client").connectAgent>
      >,
  );
});

after(async () => {
  __setAgentConnectorForTest();
  __resetTestDb();
  await pg.close();
});

beforeEach(async () => {
  writes.length = 0;
  await pg.exec(`truncate table
    folder_grants, app_mounts, app_build_method_settings, app_build, apps,
    folders, servers, membership_capabilities, memberships, users, teams
    restart identity cascade;`);
  await seedIdentity(db, {
    users: [
      { id: OWNER, teamId: TEAM_A, role: "owner" },
      {
        id: MEMBER,
        teamId: TEAM_A,
        role: "member",
        isInstanceAdmin: false,
        capabilities: ["view", "configure_apps"],
      },
      {
        id: GRANTEE,
        teamId: TEAM_A,
        role: "member",
        isInstanceAdmin: false,
        capabilities: ["view"],
      },
    ],
  });
  await seedServer(db);
  await db.insert(foldersTable).values({
    id: FLD,
    teamId: TEAM_A,
    name: "Secret",
    parentId: null,
    color: null,
    ownerUserId: OWNER,
    createdAt: T0,
    updatedAt: T0,
  });
  await seedApp(db, { id: PRJ_IN, teamId: TEAM_A });
  await seedApp(db, { id: PRJ_TOP, teamId: TEAM_A });
  await db
    .update(appsTable)
    .set({ folderId: FLD })
    .where(eq(appsTable.id, PRJ_IN));
  await db.insert(appMountsTable).values({
    appId: PRJ_TOP,
    position: 0,
    filePath: "app.conf",
    content: "old\n",
  });
});

test("configure_apps at team level writes a top-level app's config file", async () => {
  await as(MEMBER, async () => {
    assert.equal(await writeAppFile(PRJ_TOP, "app.conf", "new\n"), "app.conf");
    assert.equal((await readAppStorageFile(PRJ_TOP, "app.conf")).state, "text");
  });
  const rows = await db
    .select()
    .from(appMountsTable)
    .where(eq(appMountsTable.appId, PRJ_TOP));
  assert.deepEqual(
    rows.map((r) => r.content),
    ["new\n"],
  );
});

test("a member with no configure_apps is refused by the data layer itself", async () => {
  await as(GRANTEE, async () => {
    await assert.rejects(
      () => writeAppFile(PRJ_TOP, "app.conf", "hijack\n"),
      /permission|not found/i,
    );
    await assert.rejects(
      () => readAppStorageFile(PRJ_TOP, "app.conf"),
      /permission|not found/i,
    );
  });
  assert.deepEqual(writes, [], "a refused write still reached the agent");
  const rows = await db
    .select()
    .from(appMountsTable)
    .where(eq(appMountsTable.appId, PRJ_TOP));
  assert.deepEqual(
    rows.map((r) => r.content),
    ["old\n"],
  );
});

test("team-wide configure_apps does not reach an app inside a folder", async () => {
  await as(MEMBER, async () => {
    await assert.rejects(
      () => writeAppFile(PRJ_IN, "app.conf", "x"),
      /permission|not found/i,
    );
  });
  assert.deepEqual(writes, []);
});

test("a folder grant of configure_apps does reach it", async () => {
  await as(OWNER, () => setFolderGrant(FLD, GRANTEE, ["configure_apps"]));
  await as(GRANTEE, async () => {
    assert.equal(await writeAppFile(PRJ_IN, "app.conf", "y"), "app.conf");
  });
  assert.deepEqual(writes, ["app.conf"]);
});

test("a folder grant that is not configure_apps does not", async () => {
  await as(OWNER, () => setFolderGrant(FLD, GRANTEE, ["view_logs"]));
  await as(GRANTEE, async () => {
    await assert.rejects(
      () => writeAppFile(PRJ_IN, "app.conf", "z"),
      /permission|not found/i,
    );
  });
  assert.deepEqual(writes, []);
});

test("another team's app is not found, never merely refused", async () => {
  await as(MEMBER, async () => {
    await assert.rejects(
      () => writeAppFile("prj_does_not_exist", "app.conf", "x"),
      /not found/i,
    );
  });
});
