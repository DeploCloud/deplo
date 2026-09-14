import { test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";

import {
  membershipCapabilities as membershipCapabilitiesTable,
  memberships as membershipsTable,
  teamRoles as teamRolesTable,
} from "../../db/schema/control-plane/access-control";
import { projects as projectsTable } from "../../db/schema/control-plane/projects";
import { seedApp } from "../app-graph-test-helpers";
import {
  deleteProject,
  renameProject,
  setProjectColor,
} from "../projects/lifecycle";
import type { Capability } from "../../types/identity";
import {
  APP_IN_PRC,
  DEV,
  PRC_IN,
  PRC_OUT,
  ROLE,
  T0,
  as,
  reaches,
  scopeTo,
  setupRoleScope,
} from "./role-scope-test-helpers";

const h = setupRoleScope();

test("a limited member creates and moves inside their scope, and nowhere else", async () => {
  const { createApp } = await import("../apps/create");
  const { moveAppToProject } = await import("../projects/placement");
  const { getProjectBySlug } = await import("../projects/read");
  const { listEnvironmentsForProject } = await import("../environments");

  await scopeTo(h, { projects: [PRC_IN] });
  await h.pg.exec(
    `insert into membership_capabilities (membership_id, capability)
     select id, 'create_apps' from memberships where user_id = '${DEV}'
     union all
     select id, 'move_apps' from memberships where user_id = '${DEV}'`,
  );

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

  await assert.rejects(
    () => as(DEV, () => moveAppToProject(APP_IN_PRC, PRC_OUT)),
    /Project not found/,
  );

  assert.equal(await as(DEV, () => getProjectBySlug("out")), null);
  assert.deepEqual(
    await as(DEV, () => listEnvironmentsForProject(PRC_OUT)),
    [],
  );
});

test("a move cannot file an app anywhere the role does not reach", async () => {
  const { moveAppToEnvironment, moveAppToProject } =
    await import("../projects/placement");
  const { environments } =
    await import("../../db/schema/control-plane/projects");
  await h.db.insert(environments).values([
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
  await seedApp(h.db, {
    id: "prj_prod",
    projectId: PRC_IN,
    environmentId: "environ_prod",
  });

  const { teamRoleScopeEnvironments } =
    await import("../../db/schema/control-plane/access-control");
  await h.db
    .update(teamRolesTable)
    .set({ scoped: true })
    .where(eq(teamRolesTable.id, ROLE));
  await h.db
    .insert(teamRoleScopeEnvironments)
    .values({ roleId: ROLE, environmentId: "environ_prod" });
  await h.pg.exec(
    `insert into membership_capabilities (membership_id, capability)
     select id, 'move_apps' from memberships where user_id = '${DEV}'`,
  );

  assert.ok(await reaches({ kind: "app", id: "prj_prod" }));

  await assert.rejects(
    () => as(DEV, () => moveAppToEnvironment("prj_prod", "environ_stg")),
    /Environment not found/,
    "an env-scoped role filed its app into an environment it cannot reach",
  );
  await assert.rejects(
    () => as(DEV, () => moveAppToProject("prj_prod", null)),
    /only reaches part of this team/,
    "a limited role orphaned its app out of everyone's reach",
  );

  await h.db
    .delete(teamRoleScopeEnvironments)
    .where(eq(teamRoleScopeEnvironments.roleId, ROLE));
  await scopeTo(h, { projects: [PRC_IN] });
  await as(DEV, () => moveAppToEnvironment("prj_prod", "environ_stg"));
  assert.ok(await reaches({ kind: "app", id: "prj_prod" }));
});

test("a project outside a limited member's reach is NOT FOUND to rename, recolour or delete", async () => {
  await scopeTo(h, { projects: [PRC_IN] });
  const m = (
    await h.db
      .select({ id: membershipsTable.id })
      .from(membershipsTable)
      .where(eq(membershipsTable.userId, DEV))
  )[0];
  await h.db
    .insert(membershipCapabilitiesTable)
    .values(
      (["organize_projects", "delete_projects"] as Capability[]).map(
        (capability) => ({ membershipId: m.id, capability }),
      ),
    );
  for (const attempt of [
    () => renameProject(PRC_OUT, "Taken"),
    () => setProjectColor(PRC_OUT, "#ff0000"),
    () => deleteProject(PRC_OUT),
  ])
    await assert.rejects(() => as(DEV, attempt), /Project not found/);
  await as(DEV, () => renameProject(PRC_IN, "Renamed"));
  const names = await h.db
    .select({ id: projectsTable.id, name: projectsTable.name })
    .from(projectsTable);
  assert.deepEqual(Object.fromEntries(names.map((p) => [p.id, p.name])), {
    [PRC_IN]: "Renamed",
    [PRC_OUT]: "Out",
  });
});
