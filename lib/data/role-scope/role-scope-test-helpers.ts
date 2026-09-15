import { before, after, beforeEach } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../../db/test-harness";
import { __setTestDb, __resetTestDb } from "../../db/client";
import {
  memberships as membershipsTable,
  teamRoles as teamRolesTable,
  teamRoleCapabilities as teamRoleCapabilitiesTable,
  teamRoleScopeApps,
  teamRoleScopeFolders,
  teamRoleScopeProjects,
} from "../../db/schema/control-plane/access-control";
import {
  folders as foldersTable,
  projects as projectsTable,
} from "../../db/schema/control-plane/projects";
import { runWithIdentity } from "../../auth/request-context";
import { seedIdentity, TEAM_A } from "../identity-test-helpers";
import { seedApp, seedServer } from "../app-graph-test-helpers";
import { nodeCapabilities } from "../node-access";
import type { Capability } from "../../types/identity";

export const T0 = "2026-01-01T00:00:00.000Z";
export const ADMIN = "u_admin";
export const DEV = "u_dev";
export const ROLE = "role_scoped";

export const PRC_IN = "prc_in";
export const PRC_OUT = "prc_out";
export const FLD_IN = "fld_in";
export const FLD_CHILD = "fld_child";
export const FLD_OUT = "fld_out";
export const APP_IN_PRC = "prj_in_prc";
export const APP_OUT_PRC = "prj_out_prc";
export const APP_IN_FLD = "prj_in_fld";
export const APP_IN_CHILD = "prj_in_child";
export const APP_OUT_FLD = "prj_out_fld";
export const APP_TOP = "prj_top";

export type Harness = { db: TestDb; pg: PGlite };

export const as = <T>(userId: string, fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId, teamId: TEAM_A }, fn);

export const capsOn = (node: Parameters<typeof nodeCapabilities>[0]) =>
  as(DEV, () => nodeCapabilities(node));

export const reaches = async (node: Parameters<typeof nodeCapabilities>[0]) =>
  (await capsOn(node)).length > 0;

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

export function setupRoleScope(): Harness {
  const h = {} as Harness;

  before(async () => {
    const made = await makeTestDb();
    h.db = made.db;
    h.pg = made.pg;
    __setTestDb(made.db);
  });

  after(async () => {
    __resetTestDb();
    await h.pg.close();
  });

  beforeEach(async () => {
    await h.pg.exec(`truncate table
      team_role_scope_apps, team_role_scope_folders, team_role_scope_projects,
      team_role_scope_environments, environment_grants, environments,
      backup_runs, backups, backup_destination, databases, activities,
      shared_env_var_apps, shared_env_var_projects, shared_env_var_environments,
      shared_env_var_targets, shared_env_vars,
      app_grants, folder_grants, project_grants,
      team_role_capabilities, team_roles,
      app_build_method_settings, app_build, apps, folders, projects, servers,
      membership_capabilities, memberships, users, teams restart identity cascade;`);
    await seedIdentity(h.db, {
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
    await seedServer(h.db);

    await h.db.insert(projectsTable).values([
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
    await h.db
      .insert(foldersTable)
      .values([
        folder(FLD_IN),
        { ...folder(FLD_CHILD), parentId: FLD_IN },
        folder(FLD_OUT),
      ]);
    await seedApp(h.db, { id: APP_IN_PRC, projectId: PRC_IN });
    await seedApp(h.db, {
      id: APP_OUT_PRC,
      slug: "out-app",
      projectId: PRC_OUT,
    });
    await seedApp(h.db, { id: APP_IN_FLD, folderId: FLD_IN });
    await seedApp(h.db, { id: APP_IN_CHILD, folderId: FLD_CHILD });
    await seedApp(h.db, { id: APP_OUT_FLD, folderId: FLD_OUT });
    await seedApp(h.db, { id: APP_TOP });

    await h.db.insert(teamRolesTable).values({
      id: ROLE,
      teamId: TEAM_A,
      builtinKey: null,
      name: "Scoped",
      description: null,
      requireTwoFactor: false,
      scoped: false,
      createdAt: T0,
    });
    await h.db.insert(teamRoleCapabilitiesTable).values(
      (["view", "deploy_apps"] as Capability[]).map((capability) => ({
        roleId: ROLE,
        capability,
      })),
    );
    await h.db
      .update(membershipsTable)
      .set({ roleId: ROLE })
      .where(eq(membershipsTable.userId, DEV));
  });

  return h;
}

export async function scopeTo(
  h: Harness,
  opts: { projects?: string[]; folders?: string[]; apps?: string[] },
): Promise<void> {
  await h.db
    .update(teamRolesTable)
    .set({ scoped: true })
    .where(eq(teamRolesTable.id, ROLE));
  for (const id of opts.projects ?? [])
    await h.db
      .insert(teamRoleScopeProjects)
      .values({ roleId: ROLE, projectId: id });
  for (const id of opts.folders ?? [])
    await h.db
      .insert(teamRoleScopeFolders)
      .values({ roleId: ROLE, folderId: id });
  for (const id of opts.apps ?? [])
    await h.db.insert(teamRoleScopeApps).values({ roleId: ROLE, appId: id });
}

export async function updateRoleCaps(
  capabilities: Capability[],
): Promise<void> {
  const { updateRole } = await import("../roles/role-editing");
  await updateRole({ id: ROLE, name: "Scoped", capabilities });
}
