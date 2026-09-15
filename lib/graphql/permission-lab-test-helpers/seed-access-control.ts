import { eq } from "drizzle-orm";

import type { TestDb } from "../../db/test-harness";
import {
  appGrants as appGrantsTable,
  folderGrants as folderGrantsTable,
  memberships as membershipsTable,
  teamRoles as teamRolesTable,
  teamRoleCapabilities as teamRoleCapabilitiesTable,
  teamRoleScopeEnvironments,
  teamRoleScopeFolders,
  teamRoleScopeProjects,
} from "../../db/schema/control-plane/access-control";
import {
  APP_X,
  CONTRACTOR,
  ENV_STG,
  FLD_F,
  FLD_P,
  FOLDERDEV,
  GRANTEE,
  PRJ_A,
  ROLE_ENV,
  ROLE_FLD,
  ROLE_PRJ,
  SCOPED_CAPS,
  SOLO,
  SOLO_GRANT,
  STAGER,
  T0,
  TEAM,
} from "./fixture-ids";

export async function seedAccessControl(db: TestDb): Promise<void> {
  await db.insert(teamRolesTable).values(
    [
      [ROLE_PRJ, "Project A only"],
      [ROLE_ENV, "Staging only"],
      [ROLE_FLD, "Folder F only"],
    ].map(([id, name]) => ({
      id,
      teamId: TEAM,
      builtinKey: null,
      name,
      description: null,
      requireTwoFactor: false,
      scoped: true,
      createdAt: T0,
    })),
  );
  await db
    .insert(teamRoleCapabilitiesTable)
    .values(
      [ROLE_PRJ, ROLE_ENV, ROLE_FLD].flatMap((roleId) =>
        SCOPED_CAPS.map((capability) => ({ roleId, capability })),
      ),
    );
  await db
    .insert(teamRoleScopeProjects)
    .values({ roleId: ROLE_PRJ, projectId: PRJ_A });
  await db
    .insert(teamRoleScopeEnvironments)
    .values({ roleId: ROLE_ENV, environmentId: ENV_STG });
  await db
    .insert(teamRoleScopeFolders)
    .values({ roleId: ROLE_FLD, folderId: FLD_F });
  for (const [userId, roleId] of [
    [CONTRACTOR, ROLE_PRJ],
    [STAGER, ROLE_ENV],
    [FOLDERDEV, ROLE_FLD],
  ] as const) {
    await db
      .update(membershipsTable)
      .set({ roleId })
      .where(eq(membershipsTable.userId, userId));
  }

  await db
    .update(membershipsTable)
    .set({ granular: true })
    .where(eq(membershipsTable.userId, SOLO));
  await db.insert(appGrantsTable).values(
    SOLO_GRANT.map((capability) => ({
      appId: APP_X,
      userId: SOLO,
      capability,
    })),
  );
  await db
    .insert(folderGrantsTable)
    .values({ folderId: FLD_P, userId: GRANTEE, capability: "deploy_apps" });
}
