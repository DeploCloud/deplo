import type { PGlite } from "@electric-sql/pglite";

import type { TestDb } from "../../db/test-harness";
import { runWithIdentity } from "../../auth/request-context";
import { seedIdentity, TEAM_A, USER_1 } from "../identity-test-helpers";
import { seedApp, seedServer } from "../app-graph-test-helpers";
import { seedDatabase, seedS3, TRUNCATE_BACKUPS } from "../backup-test-helpers";

export const USER_SCHEDULER = "user_scheduler";
export const USER_RESTORER = "user_restorer";

export const asUser1 = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);

export async function seedBase(db: TestDb, pg: PGlite): Promise<void> {
  await pg.exec(`${TRUNCATE_BACKUPS}
    truncate table app_build_method_settings, app_build, apps, servers,
      users, teams restart identity cascade;`);
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      {
        id: USER_SCHEDULER,
        teamId: TEAM_A,
        role: "member",
        capabilities: ["view", "manage_backups", "restore_backups"],
      },
      {
        id: USER_RESTORER,
        teamId: TEAM_A,
        role: "member",
        capabilities: ["view", "restore_backups"],
      },
    ],
  });
  await seedServer(db);
  await seedDatabase(db, { id: "db_1", name: "main" });
  await seedApp(db, { id: "prj_1", teamId: TEAM_A });
  await seedS3(db, { id: "s3_1" });
}
