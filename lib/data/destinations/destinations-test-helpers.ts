import { runWithIdentity } from "../../auth/request-context";
import type { TestDb } from "../../db/test-harness";
import { seedIdentity, TEAM_A, TEAM_B, USER_1 } from "../identity-test-helpers";
import { seedServer } from "../app-graph-test-helpers";
import { TRUNCATE_BACKUPS } from "../backup-test-helpers";

export const TRUNCATE = `${TRUNCATE_BACKUPS}
    truncate table users, teams restart identity cascade;`;

export const asUser1 = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);

export async function seedDestinationFixtures(db: TestDb): Promise<void> {
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      { id: "user_2", teamId: TEAM_B, role: "owner" },
    ],
  });
  await seedServer(db);
}
