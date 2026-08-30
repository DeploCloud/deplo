// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { PGlite } from "@electric-sql/pglite";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb, getDb } from "../db/client";
import {
  activities as activitiesTable,
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
 * holders can touch at all. The rules under test, in the order they decide: 1. a
 * scope emptied by a cascade reaches NOTHING, never everything; 4.
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
    team_role_scope_environments, environment_grants, environments,
    backup_runs, backups, backup_destination, databases, activities,
    shared_env_var_apps, shared_env_var_projects, shared_env_var_environments,
    shared_env_var_targets, shared_env_vars,
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
    {
      id: PRC_IN,
      teamId: TEAM_A,
      name: "In",
      slug: "in",
      createdAt: T0,
      updatedAt: T0,
    },
    {
      id: PRC_OUT,
      teamId: TEAM_A,
      name: "Out",
      slug: "out",
      createdAt: T0,
      updatedAt: T0,
    },
  ]);
  // FLD_IN owns a child, so the subtree rule has something to reach. Every
  // folder is owned by ADMIN, so DEV sees them only through the scope.
  await db
    .insert(foldersTable)
    .values([
      folder(FLD_IN),
      { ...folder(FLD_CHILD), parentId: FLD_IN },
      folder(FLD_OUT),
    ]);
  await seedApp(db, { id: APP_IN_PRC, projectId: PRC_IN });
  await seedApp(db, { id: APP_OUT_PRC, slug: "out-app", projectId: PRC_OUT });
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
  await db.insert(teamRoleCapabilitiesTable).values(
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
  await db
    .update(teamRolesTable)
    .set({ scoped: true })
    .where(eq(teamRolesTable.id, ROLE));
  for (const id of opts.projects ?? [])
    await db
      .insert(teamRoleScopeProjects)
      .values({ roleId: ROLE, projectId: id });
  for (const id of opts.folders ?? [])
    await db
      .insert(teamRoleScopeFolders)
      .values({ roleId: ROLE, folderId: id });
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
  assert.deepEqual(
    (await as(DEV, () => listApps())).map((a) => a.id),
    [APP_TOP],
  );
});

test("naming one app keeps the project that holds it navigable", async () => {
  await scopeTo({ apps: [APP_IN_PRC] });

  // The app resolves…
  assert.ok(await reaches({ kind: "app", id: APP_IN_PRC }));
  // …and so does its container, or the Overview drill-in has nowhere to start
  // and the holder sees an empty dashboard with an app they cannot navigate to.
  assert.ok(
    await reaches({ kind: "project", id: PRC_IN }),
    "the project holding the named app was not navigable",
  );
  assert.equal(await reaches({ kind: "project", id: PRC_OUT }), false);
  const { listProjects } = await import("./projects");
  assert.deepEqual(
    (await as(DEV, () => listProjects())).map((p) => p.id),
    [PRC_IN],
  );
});

test("an environment scope reaches one environment of a project", async () => {
  const { updateRole } = await import("./roles");
  const envs = await import("../db/schema/control-plane");
  // Two environments of PRC_IN, an app in each.
  await db.insert(envs.environments).values([
    {
      id: "environ_stg",
      projectId: PRC_IN,
      name: "Staging",
      slug: "staging",
      kind: "custom",
      gitBranch: "",
      isDefault: false,
      position: 1,
      createdAt: T0,
      updatedAt: T0,
    },
    {
      id: "environ_prod",
      projectId: PRC_IN,
      name: "Production",
      slug: "production",
      kind: "production",
      gitBranch: "",
      isDefault: true,
      position: 0,
      createdAt: T0,
      updatedAt: T0,
    },
  ]);
  await seedApp(db, {
    id: "prj_stg",
    projectId: PRC_IN,
    environmentId: "environ_stg",
  });
  await seedApp(db, {
    id: "prj_prod",
    projectId: PRC_IN,
    environmentId: "environ_prod",
  });

  await as(ADMIN, () =>
    updateRole({
      id: ROLE,
      name: "Scoped",
      capabilities: ["view", "deploy_apps"],
      scope: { environmentIds: ["environ_stg"] },
    }),
  );

  assert.ok(await reaches({ kind: "app", id: "prj_stg" }));
  assert.equal(
    await reaches({ kind: "app", id: "prj_prod" }),
    false,
    "the other environment of the same project is out",
  );
  // …and through the GATE every app-shaped mutation and every REST edge uses,
  // not only through the resolver. `appGate` builds its own placement, so an
  // omitted `environmentId` there refused the holder every app they reach.
  const { requireAppCapability } = await import("./node-access");
  await as(DEV, () => requireAppCapability("prj_stg", "deploy_apps"));
  await assert.rejects(
    () => as(DEV, () => requireAppCapability("prj_prod", "deploy_apps")),
    /App not found/,
  );
  // The project container stays navigable - you cannot drill into staging
  // without seeing the project that holds it.
  assert.ok(await reaches({ kind: "project", id: PRC_IN }));
  assert.deepEqual(
    (await as(DEV, () => listApps())).map((a) => a.id),
    ["prj_stg"],
  );
});

test("an environment grant is a rung of its own, beating the project it sits in", async () => {
  const envs = await import("../db/schema/control-plane");
  await db.insert(envs.environments).values({
    id: "environ_stg",
    projectId: PRC_IN,
    name: "Staging",
    slug: "staging",
    kind: "custom",
    gitBranch: "",
    isDefault: false,
    position: 1,
    createdAt: T0,
    updatedAt: T0,
  });
  await seedApp(db, {
    id: "prj_stg2",
    projectId: PRC_IN,
    environmentId: "environ_stg",
  });
  // The project says one thing…
  await db
    .insert(envs.projectGrants)
    .values({ projectId: PRC_IN, userId: DEV, capability: "view_logs" });
  // …and the environment inside it says another. Most-specific-wins, and the
  // environment is more specific than the project it belongs to.
  await db.insert(envs.environmentGrants).values({
    environmentId: "environ_stg",
    userId: DEV,
    capability: "manage_env",
  });

  assert.deepEqual(await capsOn({ kind: "app", id: "prj_stg2" }), [
    "view",
    "manage_env",
  ]);
  // An app of the same project but no environment still answers the project's.
  assert.deepEqual(await capsOn({ kind: "app", id: APP_IN_PRC }), [
    "view",
    "view_logs",
  ]);
  // And the environment node itself resolves.
  assert.deepEqual(await capsOn({ kind: "environment", id: "environ_stg" }), [
    "view",
    "manage_env",
  ]);
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

/* ------------------------------------------------------------------ */
/* Writing a scope                                                     */
/* ------------------------------------------------------------------ */

test("limiting a role limits its holders, and clearing it gives them the team back", async () => {
  const { updateRole, listRoles } = await import("./roles");

  await as(ADMIN, () =>
    updateRole({
      id: ROLE,
      name: "Scoped",
      capabilities: ["view", "deploy_apps"],
      scope: { projectIds: [PRC_IN] },
    }),
  );
  assert.ok(await reaches({ kind: "app", id: APP_IN_PRC }));
  assert.equal(await reaches({ kind: "app", id: APP_OUT_PRC }), false);
  const scoped = (await as(ADMIN, () => listRoles())).find(
    (r) => r.id === ROLE,
  )!;
  assert.deepEqual(scoped.scope?.projectIds, [PRC_IN]);

  // Clearing it is a widening, and the holders get the whole team back with no
  // second act: the capabilities were never lost, only clamped.
  await as(ADMIN, () =>
    updateRole({
      id: ROLE,
      name: "Scoped",
      capabilities: ["view", "deploy_apps"],
      scope: null,
    }),
  );
  assert.ok(await reaches({ kind: "app", id: APP_OUT_PRC }));
  const wide = (await as(ADMIN, () => listRoles())).find((r) => r.id === ROLE)!;
  assert.equal(wide.scope, null);
});

test("a limited admin can neither widen a role nor reset one", async () => {
  const { updateRole, resetRole, listRoles } = await import("./roles");
  // DEV administers roles, but their own role reaches one project.
  await pg.exec(
    `insert into membership_capabilities (membership_id, capability)
     select id, 'manage_roles' from memberships where user_id = '${DEV}'`,
  );
  await db
    .insert(teamRoleCapabilitiesTable)
    .values({ roleId: ROLE, capability: "manage_roles" });
  await scopeTo({ projects: [PRC_IN] });

  await assert.rejects(
    () =>
      as(DEV, () =>
        updateRole({
          id: ROLE,
          name: "Scoped",
          capabilities: ["view", "deploy_apps", "manage_roles"],
          scope: null,
        }),
      ),
    /your own role reaches part of this team/i,
    "an admin whose own role is limited minted an unrestricted one",
  );

  // Nor through a node they can't reach.
  await assert.rejects(
    () =>
      as(DEV, () =>
        updateRole({
          id: ROLE,
          name: "Scoped",
          capabilities: ["view", "deploy_apps", "manage_roles"],
          scope: { projectIds: [PRC_OUT] },
        }),
      ),
    /isn't in this team any more/,
  );

  // And the reset button is not the way out either: a reset clears the scope.
  const viewer = (await as(ADMIN, () => listRoles())).find(
    (r) => r.builtinKey === "viewer",
  )!;
  await assert.rejects(
    () => as(DEV, () => resetRole(viewer.id)),
    /your own role reaches part of this team/i,
  );
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
    assert.equal(
      team.id,
      TEAM_A,
      "the topbar must still be able to name the team",
    );
    await reachableCapabilities();
    await getBreadcrumbGraph();
    await listMyTeams();
  });
});

test("the app pages a scoped member owns still load", async () => {
  const { listEnv } = await import("./env");
  const { listSharedVarsForApp } = await import("./shared-vars");
  const { listBackups, listBackupRuns } = await import("./backups");
  const { listDomains } = await import("./domains");
  const { listDeployments } = await import("./deployments");

  await scopeTo({ projects: [PRC_IN] });

  // Every tab of an app INSIDE the scope, as its own page loads it. These are
  // the reads that used to sit next to a team-wide one in the same
  // `Promise.all`, which is what took the page down with them.
  await as(DEV, async () => {
    await listEnv(APP_IN_PRC);
    await listSharedVarsForApp(APP_IN_PRC);
    await listBackups();
    await listBackupRuns({ appId: APP_IN_PRC });
    await listDomains(APP_IN_PRC);
    await listDeployments({ appId: APP_IN_PRC });
  });
});

test("a scoped member can still pick where an app runs", async () => {
  const { listServerChoices, listServersForCurrentTeam } =
    await import("./servers");
  await scopeTo({ projects: [PRC_IN] });

  // `create_apps` keeps its meaning inside a scope, so the create page has to
  // answer. A member who could create an app but never choose a host would hold
  // a capability that does nothing.
  const choices = await as(DEV, () => listServerChoices());
  assert.ok(choices.length > 0, "the server picker came back empty");
  assert.deepEqual(
    Object.keys(choices[0]).sort(),
    // `isDeploHost` is a deliberate fourth: it says which row is the machine
    // Deplo itself runs on, so a picker can default to it. That is a boolean
    // about a host whose address every member already types into a browser -
    // not an address, not agent state, not a metric.
    ["id", "isDeploHost", "name", "type"],
    "the picker is a menu, not the fleet's inventory",
  );

  // The fleet itself stays team-wide: names paired with addresses and state.
  await assert.rejects(
    () => as(DEV, () => listServersForCurrentTeam()),
    /only reaches part of this team/,
  );
});

/**
 * The sweep that found two leaks the rest of this file could not: a read that
 * assembles its OWN rows never passes through `node-access.ts`, which is where a
 * role scope is applied for free, so it has to ask, and two of them didn't.
 *
 * Written as a loop over the reads rather than an assertion each, because the
 * failure mode is "somebody adds a list and forgets", and a loop is what catches
 * the next one.
 */
test("no list read hands a scoped member anything outside their scope", async () => {
  const reads: [string, () => Promise<unknown>][] = [
    ["listApps", async () => (await import("./apps")).listApps()],
    ["listProjects", async () => (await import("./projects")).listProjects()],
    ["listFolders", async () => (await import("./folders")).listFolders()],
    [
      "getBreadcrumbGraph",
      async () => (await import("./breadcrumb")).getBreadcrumbGraph(),
    ],
    ["listActivity", async () => (await import("./activity")).listActivity()],
    ["listAllAppEnv", async () => (await import("./env")).listAllAppEnv()],
    [
      "listDeployments",
      async () => (await import("./deployments")).listDeployments(),
    ],
    ["listDomains", async () => (await import("./domains")).listDomains()],
    [
      "projectContents",
      async () => (await import("./projects")).projectContents(PRC_OUT),
    ],
  ];

  await scopeTo({ projects: [PRC_IN] });

  for (const [name, call] of reads) {
    const json = JSON.stringify(await as(DEV, call));
    for (const secret of [APP_OUT_PRC, PRC_OUT, "out-app"]) {
      assert.ok(
        !json.includes(secret),
        `${name} named ${secret}, which is outside the member's scope`,
      );
    }
  }
});

test("the trail and the shared library are cut to what they reach", async () => {
  const { listActivity } = await import("./activity");
  const { listSharedVarsForApp, saveSharedVar } = await import("./shared-vars");

  // An event on an out-of-scope app, and a TEAM-level one (a member added, a
  // role edited): the second has no app at all, and is the team's own history.
  await db.insert(activitiesTable).values([
    {
      id: "act_out",
      teamId: TEAM_A,
      type: "app",
      message: "OUT-APP-EVENT",
      actor: "someone",
      appId: APP_OUT_PRC,
      createdAt: T0,
    },
    {
      id: "act_team",
      teamId: TEAM_A,
      type: "member",
      message: "TEAM-LEVEL-EVENT",
      actor: "someone",
      appId: null,
      createdAt: T0,
    },
  ]);
  // A team-wide PLAIN variable: only `secret` rows are masked, so its value is
  // returned in full to anyone who can list it.
  await as(ADMIN, () =>
    saveSharedVar({
      key: "TEAM_WIDE",
      value: "PLAINTEXT-VALUE",
      type: "plain",
      teamIds: [TEAM_A],
      environmentIds: [],
      projectIds: [],
    }),
  );

  await scopeTo({ projects: [PRC_IN] });
  await pg.exec(
    `insert into membership_capabilities (membership_id, capability)
     select id, 'view_activity' from memberships where user_id = '${DEV}'
     union all
     select id, 'manage_env' from memberships where user_id = '${DEV}'`,
  );

  const trail = JSON.stringify(await as(DEV, () => listActivity()));
  assert.ok(
    !trail.includes("OUT-APP-EVENT"),
    "the trail named an app they can't reach",
  );
  assert.ok(!trail.includes("TEAM-LEVEL-EVENT"), "nor the team's own history");

  const vars = JSON.stringify(
    await as(DEV, () => listSharedVarsForApp(APP_IN_PRC)),
  );
  assert.ok(
    !vars.includes("PLAINTEXT-VALUE"),
    "the team's shared library came back from an app inside the scope",
  );
});

test("a backup schedule is reachable only through the app it belongs to", async () => {
  const { seedBackup, seedDatabase, seedS3 } =
    await import("./backup-test-helpers");
  const { listBackups, toggleBackup } = await import("./backups");
  await seedDatabase(db, { id: "db_main", name: "main" });
  await seedS3(db, { id: "s3_main" });
  await seedBackup(db, {
    id: "bk_out",
    targetKind: "app",
    appId: APP_OUT_PRC,
    destinationId: "s3_main",
  });
  await seedBackup(db, {
    id: "bk_db",
    databaseId: "db_main",
    destinationId: "s3_main",
  });

  await scopeTo({ projects: [PRC_IN] });
  await pg.exec(
    `insert into membership_capabilities (membership_id, capability)
     select id, 'manage_backups' from memberships where user_id = '${DEV}'`,
  );

  assert.deepEqual(
    (await as(DEV, () => listBackups())).map((b) => b.id),
    [],
    "the schedules of an app they can't reach, and of a database, are not theirs",
  );
  // `manage_backups` survives the clamp because it means something on an app,
  // so the team-wide capability check alone would have let this through.
  await assert.rejects(
    () => as(DEV, () => toggleBackup("bk_db", false)),
    /not found/i,
  );
  await assert.rejects(
    () => as(DEV, () => toggleBackup("bk_out", false)),
    /not found/i,
  );
});

test("a limited member creates and moves inside their scope, and nowhere else", async () => {
  const { createApp } = await import("./apps");
  const { moveAppToProject } = await import("./projects");
  const { getProjectBySlug } = await import("./projects");
  const { listEnvironmentsForProject } = await import("./environments");

  await scopeTo({ projects: [PRC_IN] });
  await pg.exec(
    `insert into membership_capabilities (membership_id, capability)
     select id, 'create_apps' from memberships where user_id = '${DEV}'
     union all
     select id, 'move_apps' from memberships where user_id = '${DEV}'`,
  );

  // Creating inside the scope works; outside it answers as a project that is
  // not there. The create path is how anyone walks out of their own boundary.
  const made = await as(DEV, () =>
    createApp({
      name: "mine",
      source: "upload",
      repo: null,
      projectId: PRC_IN,
    }),
  );
  assert.equal(made.projectId, PRC_IN);
  await assert.rejects(
    () =>
      as(DEV, () =>
        createApp({
          name: "theirs",
          source: "upload",
          repo: null,
          projectId: PRC_OUT,
        }),
      ),
    /Project not found/,
    "an app was created inside a project the role does not reach",
  );

  // Nor is an out-of-scope project a destination to move into.
  await assert.rejects(
    () => as(DEV, () => moveAppToProject(APP_IN_PRC, PRC_OUT)),
    /Project not found/,
  );

  // Nor readable by name, nor enumerable through its environments.
  assert.equal(await as(DEV, () => getProjectBySlug("out")), null);
  assert.deepEqual(
    await as(DEV, () => listEnvironmentsForProject(PRC_OUT)),
    [],
  );
});

test("the live database stream refuses a scoped member, with no request to read", async () => {
  const { seedDatabase } = await import("./backup-test-helpers");
  const { databaseStatusStream } = await import("../graphql/types/database");
  await seedDatabase(db, { id: "db_main", name: "main" });
  await scopeTo({ projects: [PRC_IN] });

  // Driven exactly as production drives it: a generator's ticks run after the
  // HTTP handler returned the streaming Response, so there is no request scope
  // and no cookies. The principal has to ride in from the GraphQL context -
  // leaning on a request-scoped gate here answered "unrestricted" and handed a
  // limited member the database's host, port, user and masked connection string.
  await assert.rejects(
    () => databaseStatusStream("db_main", TEAM_A, DEV).next(),
    /Database not found/,
    "the stream handed a scoped member a database",
  );

  // The control: unscoped, the same call streams.
  await db
    .update(teamRolesTable)
    .set({ scoped: false })
    .where(eq(teamRolesTable.id, ROLE));
  const gen = databaseStatusStream("db_main", TEAM_A, DEV);
  const first = await gen.next();
  assert.equal(first.value?.id, "db_main");
  await gen.return(undefined as never);
});

test("nothing that belongs to the whole team is reachable through a point lookup", async () => {
  const { seedDatabase } = await import("./backup-test-helpers");
  await seedDatabase(db, { id: "db_main", name: "main" });
  await scopeTo({ projects: [PRC_IN] });

  // A collection says plainly that the caller is limited; a POINT LOOKUP must
  // answer as if the id did not exist, or the refusal becomes an oracle. These
  // two carried a token-only check and answered a limited member in full: the
  // database with its whole row, the host with its address and status.
  const { getDatabase } = await import("./databases");
  const { getServer } = await import("./servers");
  assert.equal(await as(DEV, () => getDatabase("db_main")), null);
  assert.equal(await as(DEV, () => getServer("srv_1")), null);

  // The control: unscoped, both answer.
  await db
    .update(teamRolesTable)
    .set({ scoped: false })
    .where(eq(teamRolesTable.id, ROLE));
  assert.ok(await as(DEV, () => getDatabase("db_main")));
  assert.ok(await as(DEV, () => getServer("srv_1")));
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
  const { listDestinations } = await import("./destinations");
  const { listNotificationChannels } = await import("./notifications");

  const reads: [string, () => Promise<unknown>][] = [
    ["members", listMembers],
    ["roles", listRoles],
    ["tokens", listTokens],
    ["registries", listRegistries],
    ["databases", listDatabases],
    ["shared variables", listSharedVars],
    ["team settings", getTeam],
    ["git connections", listGithubApps],
    ["backup destinations", listDestinations],
    ["notifications", listNotificationChannels],
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
        // "API token" - one of these resources IS the team's API tokens.
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
  await db
    .delete(teamRoleCapabilitiesTable)
    .where(eq(teamRoleCapabilitiesTable.roleId, ROLE));
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

/* ------------------------------------------------------------------ */
/* The audit's regressions. Each of these leaked, escalated or broke.  */
/* ------------------------------------------------------------------ */

test("a backup RUN history is reachable only through the app it belongs to", async () => {
  const { seedBackup, seedRun, seedS3 } = await import("./backup-test-helpers");
  const { listBackupRuns, countBackupArtifacts, backupDestinationsForTarget } =
    await import("./backups");
  await seedS3(db, { id: "s3_main" });
  await seedBackup(db, {
    id: "bk_out",
    targetKind: "app",
    appId: APP_OUT_PRC,
    destinationId: "s3_main",
  });
  await seedBackup(db, {
    id: "bk_in",
    targetKind: "app",
    appId: APP_IN_PRC,
    destinationId: "s3_main",
  });
  // REAL out-of-scope data to leak. A probe against an empty table proves
  // nothing, and asserting on one is how this shipped.
  await seedRun(db, {
    id: "run_in",
    targetKind: "app",
    appId: APP_IN_PRC,
    backupId: "bk_in",
    destinationId: "s3_main",
  });
  await seedRun(db, {
    id: "run_out",
    targetKind: "app",
    appId: APP_OUT_PRC,
    backupId: "bk_out",
    destinationId: "s3_main",
  });

  await scopeTo({ projects: [PRC_IN] });
  await pg.exec(
    `insert into membership_capabilities (membership_id, capability)
     select id, 'manage_backups' from memberships where user_id = '${DEV}'`,
  );

  // The control FIRST: the app they do reach still answers, or a gate that
  // simply refuses everything would pass this test.
  assert.deepEqual(
    (await as(DEV, () => listBackupRuns({ appId: APP_IN_PRC }))).map(
      (r) => r.id,
    ),
    ["run_in"],
  );
  // `backupTargetInScope` used to fall through to `appInTeam`, whose only scope
  // clause reads `narrowedScope()` - the TOKEN's reach, null for this session.
  // The run row carries status, timings, byte size, the destination id and an
  // objectKey naming the team and the app.
  assert.deepEqual(
    await as(DEV, () => listBackupRuns({ appId: APP_OUT_PRC })),
    [],
    "the run history of an app outside the scope leaked",
  );
  assert.equal(
    await as(DEV, () =>
      countBackupArtifacts({ kind: "app", targetId: APP_OUT_PRC }),
    ),
    0,
  );
  assert.deepEqual(
    await as(DEV, () =>
      backupDestinationsForTarget({ kind: "app", targetId: APP_OUT_PRC }),
    ),
    [],
  );
});

test("a move cannot file an app anywhere the role does not reach", async () => {
  const { moveAppToEnvironment, moveAppToProject } = await import("./projects");
  const { environments } = await import("../db/schema/control-plane");
  await db.insert(environments).values([
    {
      id: "environ_prod",
      projectId: PRC_IN,
      name: "Production",
      slug: "production",
      kind: "production",
      gitBranch: "",
      isDefault: true,
      position: 0,
      createdAt: T0,
      updatedAt: T0,
    },
    {
      id: "environ_stg",
      projectId: PRC_IN,
      name: "Staging",
      slug: "staging",
      kind: "custom",
      gitBranch: "",
      isDefault: false,
      position: 1,
      createdAt: T0,
      updatedAt: T0,
    },
  ]);
  await seedApp(db, {
    id: "prj_prod",
    projectId: PRC_IN,
    environmentId: "environ_prod",
  });

  // Scoped by raw insert, like `scopeTo`: `move_apps` is not in
  // PROJECT_SCOPED_CAPABILITIES, so writing the role through `updateRole` would
  // clamp the verb away and the destination check would never be reached. A
  // holder gets it from a node grant instead (it IS in
  // NODE_GRANTABLE_CAPABILITIES), which is the shape this reproduces.
  const { teamRoleScopeEnvironments } =
    await import("../db/schema/control-plane");
  await db
    .update(teamRolesTable)
    .set({ scoped: true })
    .where(eq(teamRolesTable.id, ROLE));
  await db
    .insert(teamRoleScopeEnvironments)
    .values({ roleId: ROLE, environmentId: "environ_prod" });
  await pg.exec(
    `insert into membership_capabilities (membership_id, capability)
     select id, 'move_apps' from memberships where user_id = '${DEV}'`,
  );

  // Control: they really do hold the app and the verb.
  assert.ok(await reaches({ kind: "app", id: "prj_prod" }));

  // The sibling environment of the SAME project is reached only for
  // navigability (`appProjectIds`), never as a destination: moving there put
  // the app out of reach of every holder of the role, the mover included.
  await assert.rejects(
    () => as(DEV, () => moveAppToEnvironment("prj_prod", "environ_stg")),
    /Environment not found/,
    "an env-scoped role filed its app into an environment it cannot reach",
  );
  // The team TOP LEVEL sits inside no container and so inside no scope. This
  // branch had no destination check of any kind.
  await assert.rejects(
    () => as(DEV, () => moveAppToProject("prj_prod", null)),
    /only reaches part of this team/,
    "a limited role orphaned its app out of everyone's reach",
  );

  // …and the legitimate move still works: a PROJECT-scoped role moves freely
  // between the environments of the project it names, so this is a real gate
  // and not a blanket refusal.
  await db
    .delete(teamRoleScopeEnvironments)
    .where(eq(teamRoleScopeEnvironments.roleId, ROLE));
  await scopeTo({ projects: [PRC_IN] });
  await as(DEV, () => moveAppToEnvironment("prj_prod", "environ_stg"));
  assert.ok(await reaches({ kind: "app", id: "prj_prod" }));
});

test("the picker mutes exactly what the save clamps away", async () => {
  // The role editor draws its strikethrough from one set and the server clamps
  // with another; when they differ, the difference is granted in the UI and
  // dropped on the way in. Three capabilities sat in that gap.
  const { PROJECT_SCOPED_CAPABILITIES } = await import("../membership-shared");
  const { effectiveRoleCapabilities } = await import("./roles");
  const { ALL_CAPABILITIES } = await import("../types");
  const muted = ALL_CAPABILITIES.filter(
    (c) => !PROJECT_SCOPED_CAPABILITIES.includes(c),
  );
  const dropped = ALL_CAPABILITIES.filter(
    (c) => !effectiveRoleCapabilities([...ALL_CAPABILITIES], true).includes(c),
  );
  assert.deepEqual(
    dropped,
    muted,
    "the editor would present a capability the save throws away",
  );
});

/* ------------------------------------------------------------------ */
/* One member, moved off the role everyone else follows                */
/* ------------------------------------------------------------------ */

/**
 * The member page edits ONE person against their role: untick a place and their
 * ticks become their reach, untick a permission and the set becomes theirs.
 *
 * Both are the same trap in reverse - a limit that isn't enforced, and a limit
 * the next role edit silently hands back, so each is asserted against data
 * seeded OUTSIDE what the member ends up with.
 */
test("a member limited to one folder stops reaching the rest of the team", async () => {
  const { setMemberAccess } = await import("./user-access");

  // Control: the role is unscoped, so today they reach everything.
  assert.ok(await reaches({ kind: "app", id: APP_OUT_PRC }));
  assert.ok(await reaches({ kind: "app", id: APP_TOP }));

  await as(ADMIN, () =>
    setMemberAccess({
      userId: DEV,
      roleId: ROLE,
      granular: true,
      grants: [{ folderIds: [FLD_IN], capabilities: ["view", "deploy_apps"] }],
      capabilities: ["view", "deploy_apps"],
    }),
  );

  assert.deepEqual(await capsOn({ kind: "app", id: APP_IN_FLD }), [
    "view",
    "deploy_apps",
  ]);
  assert.deepEqual(
    await capsOn({ kind: "app", id: APP_IN_CHILD }),
    ["view", "deploy_apps"],
    "and the subtree under it",
  );
  assert.equal(
    await reaches({ kind: "app", id: APP_OUT_PRC }),
    false,
    "an app their role still reaches, and they no longer do",
  );
  assert.equal(await reaches({ kind: "app", id: APP_TOP }), false);
  assert.deepEqual(
    (await as(DEV, () => listApps())).map((a) => a.id).sort(),
    [APP_IN_CHILD, APP_IN_FLD].sort(),
    "the list agrees with the gate",
  );
  assert.deepEqual(
    (await as(DEV, () => listFolders())).map((f) => f.id).sort(),
    [FLD_CHILD, FLD_IN].sort(),
    "the folder they were given, its subtree, and no sibling of it",
  );
});

test("a permission taken from one member survives the next role edit", async () => {
  const { setMemberAccess } = await import("./user-access");
  const { updateRole } = await import("./roles");
  const { listMembers } = await import("./members");

  // Their role grants deploy_apps; this one person is not to have it.
  await as(ADMIN, () =>
    setMemberAccess({
      userId: DEV,
      roleId: ROLE,
      granular: false,
      grants: [],
      capabilities: ["view"],
    }),
  );
  assert.deepEqual(await capsOn({ kind: "app", id: APP_IN_PRC }), ["view"]);

  // The role is saved again - a rename, touching nobody's permissions on
  // purpose. Before `custom_capabilities`, this handed deploy_apps straight
  // back, which is the failure that makes the whole editor a lie.
  await as(ADMIN, () =>
    updateRole({
      id: ROLE,
      name: "Renamed",
      capabilities: ["view", "deploy_apps"],
    }),
  );
  assert.deepEqual(
    await capsOn({ kind: "app", id: APP_IN_PRC }),
    ["view"],
    "the role edit reached back into a member an admin had cut down",
  );

  // …and the roster says so, in the one place an admin would look.
  const dev = (await as(ADMIN, () => listMembers())).find(
    (m) => m.userId === DEV,
  );
  assert.equal(dev?.accessDelta, "less");
});

test("a member who follows their role still follows a role edit", async () => {
  const { updateRole } = await import("./roles");
  const { listMembers } = await import("./members");

  await as(ADMIN, () =>
    updateRole({
      id: ROLE,
      name: "Scoped",
      capabilities: ["view", "deploy_apps", "view_logs"],
    }),
  );
  assert.deepEqual(await capsOn({ kind: "app", id: APP_IN_PRC }), [
    "view",
    "deploy_apps",
    "view_logs",
  ]);
  const dev = (await as(ADMIN, () => listMembers())).find(
    (m) => m.userId === DEV,
  );
  assert.equal(dev?.accessDelta, null, "nothing about them differs from it");
});

test("a member given more than their role keeps it, and reads as more", async () => {
  const { setMemberAccess } = await import("./user-access");
  const { listMembers } = await import("./members");

  await as(ADMIN, () =>
    setMemberAccess({
      userId: DEV,
      roleId: ROLE,
      granular: false,
      grants: [],
      capabilities: ["view", "deploy_apps", "view_logs"],
    }),
  );
  assert.deepEqual(await capsOn({ kind: "app", id: APP_IN_PRC }), [
    "view",
    "deploy_apps",
    "view_logs",
  ]);
  const dev = (await as(ADMIN, () => listMembers())).find(
    (m) => m.userId === DEV,
  );
  assert.equal(dev?.accessDelta, "more");
});

test("a limited member never resolves as a team administrator", async () => {
  const { setMemberAccess } = await import("./user-access");
  const { hasCapability } = await import("../membership");

  // The role hands out manage_team, which is what makes its holders folder
  // super-users. Limiting the person must clamp it away at the source, or they
  // resolve every private folder in the team through `holdsManageTeam`.
  await as(ADMIN, () =>
    updateRoleCaps(["view", "deploy_apps", "manage_team", "manage_members"]),
  );
  await as(ADMIN, () =>
    setMemberAccess({
      userId: DEV,
      roleId: ROLE,
      granular: true,
      grants: [{ folderIds: [FLD_IN], capabilities: ["view", "deploy_apps"] }],
      capabilities: ["view", "deploy_apps", "manage_team", "manage_members"],
    }),
  );

  assert.equal(await as(DEV, () => hasCapability("manage_team")), false);
  assert.equal(await as(DEV, () => hasCapability("manage_members")), false);
  assert.equal(
    await reaches({ kind: "folder", id: FLD_OUT }),
    false,
    "a folder they were never shown stays invisible",
  );
});

/** Re-author the role's capabilities, the way the role editor does. */
async function updateRoleCaps(capabilities: Capability[]): Promise<void> {
  const { updateRole } = await import("./roles");
  await updateRole({ id: ROLE, name: "Scoped", capabilities });
}
