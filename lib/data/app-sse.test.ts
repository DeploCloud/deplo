import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PGlite } from "@electric-sql/pglite";

process.env.DEPLO_DATA_DIR = mkdtempSync(join(tmpdir(), "deplo-sse-"));

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { seedIdentity, TEAM_A, USER_1 } from "./identity-test-helpers";
import {
  seedServer,
  seedApp,
  seedDeployment,
  TRUNCATE_PROJECT_GRAPH,
} from "./app-graph-test-helpers";
import { eq } from "drizzle-orm";
import { publishAppChanged } from "../graphql/pubsub";
import { setFolderGrant } from "./folder-access";
import { runWithIdentity } from "../auth/request-context";
import { apps as appsTable } from "../db/schema/control-plane/apps";
import {
  folders as foldersTable,
  projects as projectsTable,
} from "../db/schema/control-plane/projects";
import { ALL_CAPABILITIES } from "../types/identity";
import {
  appStatusStream,
  activeDeploymentsStream,
} from "../graphql/types/app/app-subscriptions";

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
    truncate table projects, users, teams restart identity cascade;`);
  await seedIdentity(db, {
    users: [{ id: USER_1, teamId: TEAM_A, role: "owner" }],
  });
  await seedServer(db);
});

test("appStatusStream yields the initial snapshot + multiple change pings (cookie-free)", async () => {
  await seedApp(db, {
    id: "prj_1",
    slug: "alpha",
    teamId: TEAM_A,
    status: "active",
  });

  // NO runWithIdentity: if the generator read a cookie it would throw here.
  const gen = appStatusStream("alpha", TEAM_A, USER_1);

  const first = await gen.next();
  assert.equal(first.done, false);
  assert.equal(first.value.id, "prj_1");
  assert.equal(first.value.slug, "alpha");

  const p1 = gen.next();
  publishAppChanged("prj_1");
  const second = await p1;
  assert.equal(second.done, false);
  assert.equal(second.value.id, "prj_1");

  // A SECOND change across another tick - the old crash point.
  const p2 = gen.next();
  publishAppChanged("prj_1");
  const third = await p2;
  assert.equal(third.done, false);
  assert.equal(third.value.id, "prj_1");

  await gen.return(undefined as never);
});

test("appStatusStream rejects an unknown slug / wrong team", async () => {
  await seedApp(db, {
    id: "prj_1",
    slug: "alpha",
    teamId: TEAM_A,
    status: "active",
  });
  await assert.rejects(
    () => appStatusStream("nope", TEAM_A, USER_1).next(),
    /App not found/,
  );
  await assert.rejects(
    () => appStatusStream("alpha", "team_other", USER_1).next(),
    /App not found/,
  );
  await assert.rejects(
    () => appStatusStream("alpha", null, USER_1).next(),
    /App not found/,
  );
});

test("appStatusStream ends when the project is deleted mid-stream", async () => {
  await seedApp(db, {
    id: "prj_1",
    slug: "alpha",
    teamId: TEAM_A,
    status: "active",
  });
  const gen = appStatusStream("alpha", TEAM_A, USER_1);
  await gen.next();
  const p = gen.next();
  await pg.exec(`delete from apps where id = 'prj_1';`);
  publishAppChanged("prj_1");
  const next = await p;
  assert.equal(next.done, true, "generator ends when the project vanishes");
});

test("a project scope holds on EVERY tick of the stream, not just the first", async () => {
  await db.insert(projectsTable).values({
    id: "prc_out",
    teamId: TEAM_A,
    name: "Out",
    slug: "out",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  await seedApp(db, {
    id: "prj_1",
    slug: "alpha",
    teamId: TEAM_A,
    status: "active",
    projectId: "prc_out",
  });

  const token = {
    id: "tok_test",
    capabilities: [...ALL_CAPABILITIES],
    // Scoped to a project the app is NOT in.
    scope: {
      teamIds: [TEAM_A],
      wholeTeamIds: [],
      projectIds: ["prc_in"],
      folderIds: [],
      appIds: [],
      appProjectIds: [],
    },
    instanceAdmin: false,
  };
  const asScoped = <T>(fn: () => T) =>
    runWithIdentity({ userId: USER_1, teamId: TEAM_A, token }, fn);

  const gen = asScoped(() => appStatusStream("alpha", TEAM_A, USER_1));
  await assert.rejects(() => asScoped(() => gen.next()), /App not found/);

  const ok = {
    id: "tok_test",
    capabilities: [...ALL_CAPABILITIES],
    scope: {
      teamIds: [TEAM_A],
      wholeTeamIds: [],
      projectIds: ["prc_out"],
      folderIds: [],
      appIds: [],
      appProjectIds: [],
    },
    instanceAdmin: false,
  };
  const asOk = <T>(fn: () => T) =>
    runWithIdentity({ userId: USER_1, teamId: TEAM_A, token: ok }, fn);
  const gen2 = asOk(() => appStatusStream("alpha", TEAM_A, USER_1));
  assert.equal((await asOk(() => gen2.next())).value.id, "prj_1");
  const pending = asOk(() => gen2.next());
  publishAppChanged("prj_1");
  assert.equal((await pending).value.id, "prj_1");
  await asOk(() => gen2.return(undefined as never));
});

test("a member who can't see the folder can't watch the app inside it", async () => {
  // The member holds real team capabilities but no access to the folder.
  await pg.exec(`truncate table users, teams restart identity cascade;`);
  await seedIdentity(db, {
    users: [
      { id: "u_folder_owner", teamId: TEAM_A, role: "owner" },
      {
        id: "u_outsider",
        teamId: TEAM_A,
        role: "member",
        isInstanceAdmin: false,
        capabilities: ["view", "create_apps", "deploy_apps", "manage_env"],
      },
    ],
  });
  await db.insert(foldersTable).values({
    id: "fld_private",
    teamId: TEAM_A,
    name: "Private",
    parentId: null,
    color: null,
    ownerUserId: "u_folder_owner",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  await seedApp(db, {
    id: "prj_1",
    slug: "alpha",
    teamId: TEAM_A,
    status: "active",
  });
  await db
    .update(appsTable)
    .set({ folderId: "fld_private" })
    .where(eq(appsTable.id, "prj_1"));

  // A member refused the app's own page must not read it off a live feed either.
  await assert.rejects(
    () => appStatusStream("alpha", TEAM_A, "u_outsider").next(),
    /App not found/,
    "the status stream leaked an app inside a folder the member can't see",
  );

  assert.equal(
    (await appStatusStream("alpha", TEAM_A, "u_folder_owner").next()).value.id,
    "prj_1",
  );
  await runWithIdentity({ userId: "u_folder_owner", teamId: TEAM_A }, () =>
    setFolderGrant("fld_private", "u_outsider", ["view_logs"]),
  );
  assert.equal(
    (await appStatusStream("alpha", TEAM_A, "u_outsider").next()).value.id,
    "prj_1",
    "a grantee watches it like any other app",
  );
});

test("an app moved into a folder the watcher can't see ends their stream", async () => {
  await pg.exec(`truncate table users, teams restart identity cascade;`);
  await seedIdentity(db, {
    users: [
      { id: "u_folder_owner", teamId: TEAM_A, role: "owner" },
      {
        id: "u_outsider",
        teamId: TEAM_A,
        role: "member",
        isInstanceAdmin: false,
        capabilities: ["view", "create_apps", "deploy_apps"],
      },
    ],
  });
  await db.insert(foldersTable).values({
    id: "fld_private",
    teamId: TEAM_A,
    name: "Private",
    parentId: null,
    color: null,
    ownerUserId: "u_folder_owner",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  await seedApp(db, {
    id: "prj_1",
    slug: "alpha",
    teamId: TEAM_A,
    status: "active",
  });

  const gen = appStatusStream("alpha", TEAM_A, "u_outsider");
  assert.equal((await gen.next()).value.id, "prj_1");

  // The revocation has to bite on the next tick, or an older subscription outlives it.
  const pending = gen.next();
  await db
    .update(appsTable)
    .set({ folderId: "fld_private" })
    .where(eq(appsTable.id, "prj_1"));
  publishAppChanged("prj_1");
  assert.equal(
    (await pending).done,
    true,
    "the stream must end, not keep feeding",
  );
});

test("activeDeploymentsStream counts in-flight builds and only pushes on change", async () => {
  await seedApp(db, {
    id: "prj_1",
    slug: "alpha",
    teamId: TEAM_A,
    status: "active",
  });
  await seedDeployment(db, { id: "dep_1", appId: "prj_1", status: "building" });
  await seedDeployment(db, { id: "dep_2", appId: "prj_1", status: "queued" });
  await seedDeployment(db, { id: "dep_3", appId: "prj_1", status: "ready" });

  // No runWithIdentity: the chip reads this from an SSE tick, cookies long gone.
  const gen = activeDeploymentsStream(TEAM_A, USER_1);
  assert.equal((await gen.next()).value, 2);

  const pending = gen.next();
  await pg.exec(`update deployments set status = 'ready' where id = 'dep_1';`);
  publishAppChanged("prj_1");
  assert.equal((await pending).value, 1);

  await pg.exec(
    `update deployments set status = 'canceled' where id = 'dep_2';`,
  );
  const drained = gen.next();
  publishAppChanged("prj_1");
  assert.equal((await drained).value, 0);

  await gen.return(undefined as never);
});

test("a build inside a folder the member can't see is not counted", async () => {
  await pg.exec(`truncate table users, teams restart identity cascade;`);
  await seedIdentity(db, {
    users: [
      { id: "u_folder_owner", teamId: TEAM_A, role: "owner" },
      {
        id: "u_outsider",
        teamId: TEAM_A,
        role: "member",
        isInstanceAdmin: false,
        capabilities: ["view", "create_apps", "deploy_apps"],
      },
    ],
  });
  await db.insert(foldersTable).values({
    id: "fld_private",
    teamId: TEAM_A,
    name: "Private",
    parentId: null,
    color: null,
    ownerUserId: "u_folder_owner",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  await seedApp(db, {
    id: "prj_1",
    slug: "alpha",
    teamId: TEAM_A,
    status: "active",
  });
  await db
    .update(appsTable)
    .set({ folderId: "fld_private" })
    .where(eq(appsTable.id, "prj_1"));
  await seedDeployment(db, { id: "dep_1", appId: "prj_1", status: "building" });

  // A count is still "something is happening in a folder you are refused".
  assert.equal(
    (await activeDeploymentsStream(TEAM_A, "u_outsider").next()).value,
    0,
  );
  assert.equal(
    (await activeDeploymentsStream(TEAM_A, "u_folder_owner").next()).value,
    1,
  );
});
