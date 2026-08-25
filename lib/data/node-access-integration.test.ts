import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { PGlite } from "@electric-sql/pglite";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import {
  appGrants as appGrantsTable,
  folderGrants as folderGrantsTable,
  folders as foldersTable,
  projectGrants as projectGrantsTable,
  projects as projectsTable,
} from "../db/schema/control-plane";
import { runWithIdentity } from "../auth/request-context";
import { seedIdentity, TEAM_A, TEAM_B } from "./identity-test-helpers";
import { seedApp, seedServer } from "./app-graph-test-helpers";
import { nodeCapabilities } from "./node-access";
import { listApps } from "./apps";
import { moveAppToFolder } from "./folders";
import type { Capability } from "../types";

/**
 * The precedence ladder of ADR-0016, end to end against pglite: a node capability
 * set REPLACES the team role's inside that node and may exceed it, with the most
 * specific node winning.
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

const T0 = "2026-01-01T00:00:00.000Z";

const ADMIN = "u_admin"; // team owner, so also the folder owner below
const DEV = "u_dev"; // role: view + deploy_apps
const OUTSIDER = "u_outsider"; // member of TEAM_B only

const PRC = "prc_container";
const FLD_PROD = "fld_prod";
const FLD_CHILD = "fld_child";
const APP_IN_PROD = "prj_in_prod";
const APP_IN_CHILD = "prj_in_child";
const APP_TOP = "prj_top";
const APP_IN_PRC = "prj_in_container";

const ROLE_CAPS: Capability[] = ["view", "deploy_apps"];

const as = <T>(
  userId: string,
  fn: () => Promise<T>,
  teamId = TEAM_A,
): Promise<T> => runWithIdentity({ userId, teamId }, fn);

/** DEV's effective set on a node, sorted for stable comparison. */
const capsOn = (
  node: Parameters<typeof nodeCapabilities>[0],
  userId = DEV,
  teamId = TEAM_A,
): Promise<Capability[]> =>
  as(userId, async () => [...(await nodeCapabilities(node))].sort(), teamId);

beforeEach(async () => {
  await pg.exec(`truncate table
    app_grants, folder_grants, project_grants,
    app_build_method_settings, app_build, apps, folders, projects, servers,
    membership_capabilities, memberships, users, teams restart identity cascade;`);
  await seedIdentity(db, {
    teams: [
      { id: TEAM_A, slug: "team-a" },
      { id: TEAM_B, slug: "team-b" },
    ],
    users: [
      { id: ADMIN, teamId: TEAM_A, role: "owner" },
      {
        id: DEV,
        teamId: TEAM_A,
        role: "member",
        isInstanceAdmin: false,
        capabilities: ROLE_CAPS,
      },
      {
        id: OUTSIDER,
        teamId: TEAM_B,
        role: "member",
        isInstanceAdmin: false,
        capabilities: ROLE_CAPS,
      },
    ],
  });
  await seedServer(db);

  await db.insert(projectsTable).values({
    id: PRC,
    teamId: TEAM_A,
    name: "Container",
    slug: "container",
    color: null,
    ownerUserId: ADMIN,
    createdAt: T0,
    updatedAt: T0,
  });
  // Prod, and a subfolder inside it, both owned by ADMIN so DEV reaches them only
  // through grants.
  await db.insert(foldersTable).values([
    {
      id: FLD_PROD,
      teamId: TEAM_A,
      name: "Prod",
      parentId: null,
      color: null,
      ownerUserId: ADMIN,
      projectId: null,
      createdAt: T0,
      updatedAt: T0,
    },
    {
      id: FLD_CHILD,
      teamId: TEAM_A,
      name: "Prod / api",
      parentId: FLD_PROD,
      color: null,
      ownerUserId: ADMIN,
      projectId: null,
      createdAt: T0,
      updatedAt: T0,
    },
  ]);
  await seedApp(db, { id: APP_IN_PROD, teamId: TEAM_A, folderId: FLD_PROD });
  await seedApp(db, { id: APP_IN_CHILD, teamId: TEAM_A, folderId: FLD_CHILD });
  await seedApp(db, { id: APP_TOP, teamId: TEAM_A });
  await seedApp(db, { id: APP_IN_PRC, teamId: TEAM_A, projectId: PRC });
});

const grantFolder = (folderId: string, caps: Capability[], userId = DEV) =>
  db
    .insert(folderGrantsTable)
    .values(caps.map((c) => ({ folderId, userId, capability: c })));

const grantApp = (appId: string, caps: Capability[], userId = DEV) =>
  db
    .insert(appGrantsTable)
    .values(caps.map((c) => ({ appId, userId, capability: c })));

const grantProject = (projectId: string, caps: Capability[], userId = DEV) =>
  db
    .insert(projectGrantsTable)
    .values(caps.map((c) => ({ projectId, userId, capability: c })));

/* ------------------------------------------------------------------ */

test("a folder grant replaces the role inside it, and may exceed it", async () => {
  await grantFolder(FLD_PROD, ["manage_env", "delete_apps"]);

  const inside = await capsOn({ kind: "folder", id: FLD_PROD });
  assert.deepEqual(inside, ["view", "delete_apps", "manage_env"].sort());

  // The app filed in that folder inherits the same answer.
  assert.deepEqual(
    await capsOn({ kind: "app", id: APP_IN_PROD }),
    ["view", "delete_apps", "manage_env"].sort(),
  );

  // Outside it, the role is untouched: deploy_apps back, manage_env gone.
  assert.deepEqual(
    await capsOn({ kind: "app", id: APP_TOP }),
    ROLE_CAPS.sort(),
  );
});

test("with no grant anywhere, a member falls through to their role", async () => {
  assert.deepEqual(
    await capsOn({ kind: "app", id: APP_TOP }),
    ROLE_CAPS.sort(),
  );
  // A folder they were never given stays invisible, which is what keeps folders private.
  assert.deepEqual(await capsOn({ kind: "folder", id: FLD_PROD }), []);
  assert.deepEqual(await capsOn({ kind: "app", id: APP_IN_PROD }), []);
});

test("an ancestor grant reaches the subtree, and the nearer node wins", async () => {
  await grantFolder(FLD_PROD, ["manage_env"]);
  // Inherited by the child folder and the app inside it.
  assert.deepEqual(
    await capsOn({ kind: "app", id: APP_IN_CHILD }),
    ["view", "manage_env"].sort(),
  );
  // A grant on the child replaces the ancestor's outright — not a union.
  await grantFolder(FLD_CHILD, ["view_logs"]);
  assert.deepEqual(
    await capsOn({ kind: "app", id: APP_IN_CHILD }),
    ["view", "view_logs"].sort(),
  );
});

test("an app grant beats the folder it lives in", async () => {
  await grantFolder(FLD_PROD, ["manage_env"]);
  await grantApp(APP_IN_PROD, ["deploy_apps"]);
  assert.deepEqual(
    await capsOn({ kind: "app", id: APP_IN_PROD }),
    ["view", "deploy_apps"].sort(),
  );
  // The folder itself still answers with its own grant.
  assert.deepEqual(
    await capsOn({ kind: "folder", id: FLD_PROD }),
    ["view", "manage_env"].sort(),
  );
});

test("a project grant governs the apps filed under it, and never hides them", async () => {
  await grantProject(PRC, ["manage_domains"]);
  assert.deepEqual(
    await capsOn({ kind: "app", id: APP_IN_PRC }),
    ["view", "manage_domains"].sort(),
  );
  // With no grant at all a project-filed app is still reachable on the role alone:
  // unlike a folder, a Project has no privacy rule.
  await db.delete(projectGrantsTable);
  assert.deepEqual(
    await capsOn({ kind: "app", id: APP_IN_PRC }),
    ROLE_CAPS.sort(),
  );
});

/**
 * The gate a move runs, rather than the set it resolves. A grant REPLACES the
 * role inside its node, so a team-wide capability must stop at the boundary of
 * a node whose grant withholds it — and `moveAppToFolder` used to ask the TEAM
 * for `move_apps` and then gate only the source FOLDER, which left every app
 * inside a project answering to the team-wide set alone.
 */
test("a project grant that withholds move_apps stops the team-wide one", async () => {
  await pg.exec(
    `insert into membership_capabilities (membership_id, capability)
     select id, 'move_apps' from memberships where user_id = '${DEV}'`,
  );
  // A destination they own outright, so nothing about the move fails there.
  const dest = "fld_dev";
  await db.insert(foldersTable).values({
    id: dest,
    teamId: TEAM_A,
    name: "Dev's own",
    parentId: null,
    color: null,
    ownerUserId: DEV,
    projectId: null,
    createdAt: T0,
    updatedAt: T0,
  });

  // Free to move an app that answers to their role.
  await as(DEV, () => moveAppToFolder(APP_TOP, dest));
  assert.equal(
    (await as(ADMIN, () => listApps())).find((a) => a.id === APP_TOP)?.folderId,
    dest,
  );

  // Not one inside a project whose grant says otherwise: the grant replaces the
  // role there, and `move_apps` is not in it.
  await grantProject(PRC, ["deploy_apps"]);
  await assert.rejects(
    () => as(DEV, () => moveAppToFolder(APP_IN_PRC, dest)),
    /permission to move/i,
  );
  assert.equal(
    (await as(ADMIN, () => listApps())).find((a) => a.id === APP_IN_PRC)
      ?.folderId,
    null,
    "and the app stayed in its project",
  );
});

test("losing the membership revokes every node grant, live", async () => {
  await grantFolder(FLD_PROD, ["manage_env", "delete_apps"]);
  assert.ok((await capsOn({ kind: "app", id: APP_IN_PROD })).length > 0);

  await pg.exec(`delete from memberships where user_id = '${DEV}'`);
  assert.deepEqual(await capsOn({ kind: "app", id: APP_IN_PROD }), []);
  assert.deepEqual(await capsOn({ kind: "folder", id: FLD_PROD }), []);
});

test("a grant in one team resolves to nothing in another", async () => {
  await grantFolder(FLD_PROD, ["manage_env"], OUTSIDER);
  // OUTSIDER belongs to TEAM_B only, so the grant is inert: membership is checked
  // first and there is none in the folder's team.
  assert.deepEqual(
    await capsOn({ kind: "folder", id: FLD_PROD }, OUTSIDER, TEAM_B),
    [],
  );
});

test("a super-user is unaffected by node grants", async () => {
  await grantFolder(FLD_PROD, ["view_logs"], ADMIN);
  const caps = await capsOn({ kind: "app", id: APP_IN_PROD }, ADMIN);
  assert.ok(
    caps.includes("manage_members"),
    "the owner keeps their whole team set",
  );
  assert.ok(caps.includes("deploy_apps"));
});
