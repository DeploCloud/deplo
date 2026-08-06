import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { PGlite } from "@electric-sql/pglite";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb, getDb } from "../db/client";
import {
  folderGrants as folderGrantsTable,
  folders as foldersTable,
  memberships as membershipsTable,
  projects as projectsTable,
  teamRoles as teamRolesTable,
  teamRoleCapabilities as teamRoleCapabilitiesTable,
  teamRoleScopeApps,
  teamRoleScopeFolders,
  teamRoleScopeProjects,
} from "../db/schema/control-plane";
import { runWithIdentity } from "../auth/request-context";
import { seedIdentity, TEAM_A } from "./identity-test-helpers";
import { seedApp, seedServer } from "./app-graph-test-helpers";
import { nodeCapabilities } from "./node-access";
import { listApps } from "./apps";
import { listFolders } from "./folders";
import type { Capability } from "../types";
import { eq } from "drizzle-orm";

/**
 * REACH, the second axis a role gained in 0069: which nodes of the team its
 * holders can touch at all.
 *
 * The rules under test, in the order they decide:
 *  1. an unscoped role reaches everything, which is every role that exists;
 *  2. a scoped one reaches what it names, its folders' subtrees included, and
 *     answers `[]` elsewhere — the same empty answer an invisible folder gives,
 *     so neither can be told from the other;
 *  3. a scope emptied by a cascade reaches NOTHING, never everything;
 *  4. a node grant EXTENDS the scope rather than being clamped by it, so a
 *     folder share stays alive when its holder is put on a limited role.
 */

let db: TestDb;
let pg: PGlite;

const T0 = "2026-01-01T00:00:00.000Z";
const ADMIN = "u_admin";
const DEV = "u_dev";
const ROLE = "role_scoped";

const PRC_IN = "prc_in";
const PRC_OUT = "prc_out";
const FLD_IN = "fld_in";
const FLD_CHILD = "fld_child";
const FLD_OUT = "fld_out";
const APP_IN_PRC = "prj_in_prc";
const APP_OUT_PRC = "prj_out_prc";
const APP_IN_FLD = "prj_in_fld";
const APP_IN_CHILD = "prj_in_child";
const APP_OUT_FLD = "prj_out_fld";
const APP_TOP = "prj_top";

const as = <T>(userId: string, fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId, teamId: TEAM_A }, fn);

/** DEV's effective set on a node. */
const capsOn = (node: Parameters<typeof nodeCapabilities>[0]) =>
  as(DEV, () => nodeCapabilities(node));

const reaches = async (node: Parameters<typeof nodeCapabilities>[0]) =>
  (await capsOn(node)).length > 0;

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
});

after(async () => {
  __resetTestDb();
  await pg.close();
});

const folder = (id: string, opts: { projectId?: string | null } = {}) => ({
  id,
  teamId: TEAM_A,
  name: id,
  parentId: null,
  color: null,
  ownerUserId: ADMIN,
  projectId: opts.projectId ?? null,
  createdAt: T0,
  updatedAt: T0,
});

beforeEach(async () => {
  await pg.exec(`truncate table
    team_role_scope_apps, team_role_scope_folders, team_role_scope_projects,
    app_grants, folder_grants, project_grants,
    team_role_capabilities, team_roles,
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
        capabilities: ["view", "deploy_apps"] as Capability[],
      },
    ],
  });
  await seedServer(db);

  await db.insert(projectsTable).values([
    { id: PRC_IN, teamId: TEAM_A, name: "In", slug: "in", createdAt: T0, updatedAt: T0 },
    { id: PRC_OUT, teamId: TEAM_A, name: "Out", slug: "out", createdAt: T0, updatedAt: T0 },
  ]);
  // FLD_IN owns a child, so the subtree rule has something to reach. Every
  // folder is owned by ADMIN, so DEV sees them only through the scope.
  await db.insert(foldersTable).values([
    folder(FLD_IN),
    { ...folder(FLD_CHILD), parentId: FLD_IN },
    folder(FLD_OUT),
  ]);
  await seedApp(db, { id: APP_IN_PRC, projectId: PRC_IN });
  await seedApp(db, { id: APP_OUT_PRC, projectId: PRC_OUT });
  await seedApp(db, { id: APP_IN_FLD, folderId: FLD_IN });
  await seedApp(db, { id: APP_IN_CHILD, folderId: FLD_CHILD });
  await seedApp(db, { id: APP_OUT_FLD, folderId: FLD_OUT });
  await seedApp(db, { id: APP_TOP });

  // The role DEV holds. Born unscoped, like every role in every instance.
  await db.insert(teamRolesTable).values({
    id: ROLE,
    teamId: TEAM_A,
    builtinKey: null,
    name: "Scoped",
    description: null,
    requireTwoFactor: false,
    scoped: false,
    createdAt: T0,
  });
  await db
    .insert(teamRoleCapabilitiesTable)
    .values(
      (["view", "deploy_apps"] as Capability[]).map((capability) => ({
        roleId: ROLE,
        capability,
      })),
    );
  await db
    .update(membershipsTable)
    .set({ roleId: ROLE })
    .where(eq(membershipsTable.userId, DEV));
});

/** Limit the role to the given nodes. */
async function scopeTo(opts: {
  projects?: string[];
  folders?: string[];
  apps?: string[];
}): Promise<void> {
  await db.update(teamRolesTable).set({ scoped: true }).where(eq(teamRolesTable.id, ROLE));
  for (const id of opts.projects ?? [])
    await db.insert(teamRoleScopeProjects).values({ roleId: ROLE, projectId: id });
  for (const id of opts.folders ?? [])
    await db.insert(teamRoleScopeFolders).values({ roleId: ROLE, folderId: id });
  for (const id of opts.apps ?? [])
    await db.insert(teamRoleScopeApps).values({ roleId: ROLE, appId: id });
}

/* ------------------------------------------------------------------ */

test("an unscoped role reaches the whole team, as every role does today", async () => {
  assert.ok(await reaches({ kind: "app", id: APP_IN_PRC }));
  assert.ok(await reaches({ kind: "app", id: APP_OUT_PRC }));
  assert.ok(await reaches({ kind: "app", id: APP_TOP }));
  assert.ok(await reaches({ kind: "project", id: PRC_OUT }));
  // Folders are the exception, and it predates scopes: they are private to their
  // owner and grantees (ADR-0016), so ADMIN's folders answer nothing either way.
  assert.equal(await reaches({ kind: "folder", id: FLD_IN }), false);
});

test("a project scope reaches its apps and its container, and nothing else", async () => {
  await scopeTo({ projects: [PRC_IN] });

  assert.deepEqual(await capsOn({ kind: "app", id: APP_IN_PRC }), [
    "view",
    "deploy_apps",
  ]);
  assert.deepEqual(
    await capsOn({ kind: "app", id: APP_OUT_PRC }),
    [],
    "an app in the other project is gone",
  );
  assert.deepEqual(
    await capsOn({ kind: "app", id: APP_TOP }),
    [],
    "and so is one at the team top level, which no scope covers",
  );
  assert.ok(await reaches({ kind: "project", id: PRC_IN }));
  assert.equal(await reaches({ kind: "project", id: PRC_OUT }), false);
});

test("a folder scope reaches its whole subtree", async () => {
  await scopeTo({ folders: [FLD_IN] });

  // The folder itself and the child it contains, plus the apps in both.
  assert.ok(await reaches({ kind: "folder", id: FLD_IN }));
  assert.ok(await reaches({ kind: "folder", id: FLD_CHILD }));
  assert.ok(await reaches({ kind: "app", id: APP_IN_FLD }));
  assert.ok(await reaches({ kind: "app", id: APP_IN_CHILD }));
  assert.equal(await reaches({ kind: "folder", id: FLD_OUT }), false);
  assert.equal(await reaches({ kind: "app", id: APP_OUT_FLD }), false);

  // And the lists agree with the resolver, which is the whole point of putting
  // the gate in `node-access` rather than in each caller.
  assert.deepEqual(
    (await as(DEV, () => listFolders())).map((f) => f.id).sort(),
    [FLD_CHILD, FLD_IN].sort(),
  );
  assert.deepEqual(
    (await as(DEV, () => listApps())).map((a) => a.id).sort(),
    [APP_IN_CHILD, APP_IN_FLD].sort(),
  );
});

test("naming one app reaches that app alone", async () => {
  await scopeTo({ apps: [APP_TOP] });
  assert.ok(await reaches({ kind: "app", id: APP_TOP }));
  assert.equal(await reaches({ kind: "app", id: APP_IN_PRC }), false);
  assert.deepEqual((await as(DEV, () => listApps())).map((a) => a.id), [APP_TOP]);
});

test("a scope emptied by a cascade reaches nothing, not everything", async () => {
  await scopeTo({ projects: [PRC_IN] });
  assert.ok(await reaches({ kind: "app", id: APP_IN_PRC }));

  // Deleting the project takes the junction row with it. The `scoped` flag is
  // what stops the empty set from reading as "no scope at all".
  await db.delete(projectsTable).where(eq(projectsTable.id, PRC_IN));
  assert.deepEqual(await as(DEV, () => listApps()), []);
  assert.equal(await reaches({ kind: "app", id: APP_OUT_PRC }), false);
  assert.equal(await reaches({ kind: "app", id: APP_TOP }), false);
});

test("a folder share extends the scope instead of being clamped by it", async () => {
  await scopeTo({ projects: [PRC_IN] });
  assert.equal(await reaches({ kind: "folder", id: FLD_OUT }), false);

  // The folder's owner shares it. Intersecting would revoke this the moment its
  // holder was put on a limited role, which is a data-destroying default.
  await db
    .insert(folderGrantsTable)
    .values({ folderId: FLD_OUT, userId: DEV, capability: "manage_env" });

  assert.deepEqual(await capsOn({ kind: "folder", id: FLD_OUT }), [
    "view",
    "manage_env",
  ]);
  assert.deepEqual(
    await capsOn({ kind: "app", id: APP_OUT_FLD }),
    ["view", "manage_env"],
    "and the apps inside it, with the granted set rather than the role's",
  );
  // What the scope still holds: the share named one folder, not the team.
  assert.equal(await reaches({ kind: "app", id: APP_OUT_PRC }), false);
});

test("the reads the dashboard layout makes still answer a scoped member", async () => {
  const { getTeamIdentity } = await import("./teams");
  const { reachableCapabilities } = await import("../membership");
  const { getBreadcrumbGraph } = await import("./breadcrumb");
  const { listMyTeams } = await import("./teams");

  await scopeTo({ projects: [PRC_IN] });

  // `app/(dashboard)/layout.tsx` awaits these four on EVERY page, and its catch
  // handles only the two-factor case. One refusal here is the whole dashboard
  // rendering its error boundary over a perfectly healthy page, which is why
  // the team's identity is a separate read from its settings.
  await as(DEV, async () => {
    const team = await getTeamIdentity();
    assert.equal(team.id, TEAM_A, "the topbar must still be able to name the team");
    await reachableCapabilities();
    await getBreadcrumbGraph();
    await listMyTeams();
  });
});

test("a scoped member can still pick where an app runs", async () => {
  const { listServerChoices, listServersForCurrentTeam } = await import("./servers");
  await scopeTo({ projects: [PRC_IN] });

  // `create_apps` keeps its meaning inside a scope, so the create page has to
  // answer. A member who could create an app but never choose a host would hold
  // a capability that does nothing.
  const choices = await as(DEV, () => listServerChoices());
  assert.ok(choices.length > 0, "the server picker came back empty");
  assert.deepEqual(
    Object.keys(choices[0]).sort(),
    ["id", "name", "type"],
    "the picker is a menu, not the fleet's inventory",
  );

  // The fleet itself stays team-wide: names paired with addresses and state.
  await assert.rejects(
    () => as(DEV, () => listServersForCurrentTeam()),
    /only reaches part of this team/,
  );
});

test("every team-wide read refuses a scoped member, in their own words", async () => {
  const { listMembers } = await import("./members");
  const { listRoles } = await import("./roles");
  const { listTokens } = await import("./tokens");
  const { listRegistries } = await import("./registries");
  const { listDatabases } = await import("./databases");
  const { listSharedVars } = await import("./shared-vars");
  const { getTeam } = await import("./teams");
  const { listGithubApps } = await import("./github");
  const { listS3 } = await import("./s3");
  const { getNotificationSettings } = await import("./notifications");

  const reads: [string, () => Promise<unknown>][] = [
    ["members", listMembers],
    ["roles", listRoles],
    ["tokens", listTokens],
    ["registries", listRegistries],
    ["databases", listDatabases],
    ["shared variables", listSharedVars],
    ["team settings", getTeam],
    ["git connections", listGithubApps],
    ["S3 destinations", listS3],
    ["notifications", getNotificationSettings],
  ];

  // The control: unscoped, none of them refuses FOR THIS REASON. Some still
  // refuse on capabilities (DEV holds only view + deploy_apps), which is the
  // other axis entirely and not what this test is about.
  for (const [what, call] of reads) {
    await as(DEV, call).catch((e: Error) => {
      assert.doesNotMatch(
        e.message,
        /only reaches part of this team/,
        `${what} refused an unscoped member as if they were scoped`,
      );
    });
  }

  await scopeTo({ projects: [PRC_IN] });

  for (const [what, call] of reads) {
    await assert.rejects(
      () => as(DEV, call),
      (e: Error) => {
        assert.match(
          e.message,
          /only reaches part of this team/,
          `${what} refused for the wrong reason: ${e.message}`,
        );
        // A person is not an API token, and the enforcement mechanism is not
        // theirs to be told about. Matched on the sentence, not on the words
        // "API token" — one of these resources IS the team's API tokens.
        assert.doesNotMatch(
          e.message,
          /This API token is limited/,
          `${what} told a person their session was an API token`,
        );
        return true;
      },
      `${what} was readable by a member limited to one project`,
    );
  }
});

test("a scoped role cannot hold a team-wide capability, however it was authored", async () => {
  // Authored with the lot, including the three that lock a team out if nobody
  // holds them. The AUTHORED set is what the role editor shows.
  await db.delete(teamRoleCapabilitiesTable).where(eq(teamRoleCapabilitiesTable.roleId, ROLE));
  const authored: Capability[] = [
    "view",
    "deploy_apps",
    "manage_env",
    "manage_members",
    "manage_roles",
    "manage_team",
    "create_databases",
    "manage_tokens",
  ];
  await db
    .insert(teamRoleCapabilitiesTable)
    .values(authored.map((capability) => ({ roleId: ROLE, capability })));
  await scopeTo({ projects: [PRC_IN] });

  // Re-assigning the role is what writes the membership set, and it is where
  // the clamp lands: everything that only means something team-wide is gone.
  const { roleAssignment } = await import("./roles");
  // Through `getDb()`, which the harness has already pointed at `db`: the real
  // client is what the data layer's own types describe.
  const assignment = await roleAssignment(getDb(), TEAM_A, ROLE);
  assert.deepEqual(
    assignment.capabilities,
    ["view", "deploy_apps", "manage_env"],
    "a scoped role keeps only what still means something inside a project",
  );

  // The authored set is untouched: it is what comes back if the scope widens.
  const stored = await db
    .select({ capability: teamRoleCapabilitiesTable.capability })
    .from(teamRoleCapabilitiesTable)
    .where(eq(teamRoleCapabilitiesTable.roleId, ROLE));
  assert.equal(stored.length, authored.length);
});

test("manage_team does not lift a scope, only instance admin does", async () => {
  await scopeTo({ projects: [PRC_IN] });
  await pg.exec(
    `insert into membership_capabilities (membership_id, capability)
     select id, 'manage_team' from memberships where user_id = '${DEV}'`,
  );
  // `holdsManageTeam` reads the person's raw junction row on purpose, so the
  // scope gate has to run BEFORE the super-user branch. Writing a scoped role
  // clamps this capability away at the source; this is the second lock.
  assert.equal(
    await reaches({ kind: "app", id: APP_OUT_PRC }),
    false,
    "a scoped member with manage_team resolved the whole team",
  );
  assert.deepEqual(
    (await as(DEV, () => listFolders())).map((f) => f.id),
    [],
    "nor every folder in it",
  );

  // The instance admin is not a member acting under a role, and is unaffected.
  assert.ok((await as(ADMIN, () => listApps())).length > 0);
});
