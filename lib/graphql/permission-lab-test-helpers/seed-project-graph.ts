import type { TestDb } from "../../db/test-harness";
import {
  environments as environmentsTable,
  folders as foldersTable,
  projects as projectsTable,
} from "../../db/schema/control-plane/projects";
import {
  seedApp,
  seedDeployment,
  seedServer,
  SERVER_1,
} from "../../data/app-graph-test-helpers";
import { seedDatabase } from "../../data/backup-test-helpers";
import {
  APP_A_PROD,
  APP_A_STG,
  APP_B,
  APP_F,
  APP_F_CHILD,
  APP_P,
  APP_TOP,
  APP_X,
  DB_1,
  DEP_OLD,
  DEP_TOP,
  ENV_B,
  ENV_PROD,
  ENV_STG,
  FLD_F,
  FLD_F_CHILD,
  FLD_P,
  OWNER,
  PRJ_A,
  PRJ_B,
  T0,
  TEAM,
} from "./fixture-ids";

// seedProjectGraph fills the lab's host, projects, environments, folders, apps and database.
export async function seedProjectGraph(db: TestDb): Promise<void> {
  await seedServer(db);

  await db.insert(projectsTable).values(
    [
      [PRJ_A, "Project A", "project-a"],
      [PRJ_B, "Project B", "project-b"],
    ].map(([id, name, slug]) => ({
      id,
      teamId: TEAM,
      name,
      slug,
      createdAt: T0,
      updatedAt: T0,
    })),
  );
  await db.insert(environmentsTable).values(
    (
      [
        [ENV_PROD, PRJ_A, true, 0],
        [ENV_STG, PRJ_A, false, 1],
        [ENV_B, PRJ_B, true, 0],
      ] as const
    ).map(([id, projectId, isDefault, position]) => ({
      id,
      projectId,
      name: id,
      slug: id,
      kind: "custom" as const,
      gitBranch: "",
      isDefault,
      position,
      createdAt: T0,
      updatedAt: T0,
    })),
  );
  const folder = (id: string, parentId: string | null = null) => ({
    id,
    teamId: TEAM,
    name: id,
    parentId,
    color: null,
    ownerUserId: OWNER,
    projectId: null,
    createdAt: T0,
    updatedAt: T0,
  });
  await db
    .insert(foldersTable)
    .values([folder(FLD_F), folder(FLD_F_CHILD, FLD_F), folder(FLD_P)]);

  await seedApp(db, {
    id: APP_A_PROD,
    teamId: TEAM,
    projectId: PRJ_A,
    environmentId: ENV_PROD,
  });
  await seedApp(db, {
    id: APP_A_STG,
    teamId: TEAM,
    projectId: PRJ_A,
    environmentId: ENV_STG,
  });
  await seedApp(db, {
    id: APP_B,
    teamId: TEAM,
    projectId: PRJ_B,
    environmentId: ENV_B,
  });
  await seedApp(db, { id: APP_F, teamId: TEAM, folderId: FLD_F });
  await seedApp(db, { id: APP_F_CHILD, teamId: TEAM, folderId: FLD_F_CHILD });
  await seedApp(db, { id: APP_P, teamId: TEAM, folderId: FLD_P });
  await seedApp(db, { id: APP_TOP, teamId: TEAM, rollbackKeep: 3 });
  await seedApp(db, { id: APP_X, teamId: TEAM });
  await seedDeployment(db, {
    id: DEP_OLD,
    appId: APP_TOP,
    serverId: SERVER_1,
    imageRef: "deplo/top:old",
    createdAt: "2025-12-01T00:00:00.000Z",
  });
  await seedDeployment(db, {
    id: DEP_TOP,
    appId: APP_TOP,
    serverId: SERVER_1,
    imageRef: "deplo/top:new",
  });
  await seedDatabase(db, { id: DB_1, teamId: TEAM, name: "main" });
}
