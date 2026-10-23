import { describe, test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";

import { makeTestDb, truncateAll, type TestDb } from "../../db/test-harness";
import { __setTestDb, __resetTestDb } from "../../db/client";
import { deploMoves } from "../../db/schema/control-plane/deplo-move";
import { runWithIdentity } from "../../auth/request-context";
import { seedIdentity, TEAM_A, TEAM_B, USER_1 } from "../identity-test-helpers";
import {
  invalidateSchedulesPaused,
  resumeMoveSchedules,
  schedulesPaused,
} from "./schedules";

const T0 = "2026-10-01T00:00:00.000Z";
let db: TestDb;
let pg: PGlite;

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
});

after(async () => {
  invalidateSchedulesPaused();
  __resetTestDb();
  await pg.close();
});

beforeEach(async () => {
  await truncateAll(pg);
  invalidateSchedulesPaused();
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      { id: "user_2", teamId: TEAM_A, role: "member", isInstanceAdmin: false },
    ],
  });
});

async function seedMove(
  id: string,
  side: "source" | "target",
  state: string,
  paused: boolean,
): Promise<void> {
  await db.insert(deploMoves).values({
    id,
    side,
    state,
    schedulesPaused: paused,
    startedBy: USER_1,
    createdAt: T0,
    updatedAt: T0,
  });
}

const activityFor = async (team: string) =>
  (
    await pg.query<{ message: string; actor: string }>(
      `select message, actor from activities where team_id = $1`,
      [team],
    )
  ).rows;

describe("Deplo move: paused schedules", () => {
  test("only a move into this Deplo that is still on pauses them", async () => {
    assert.equal(await schedulesPaused(), false);
    await seedMove("dmv_src", "source", "copying", true);
    await seedMove("dmv_gone", "target", "cancelled", true);
    invalidateSchedulesPaused();
    assert.equal(await schedulesPaused(), false);

    await seedMove("dmv_in", "target", "deploying", true);
    invalidateSchedulesPaused();
    assert.equal(await schedulesPaused(), true);
  });

  test("an instance admin turns them on, and every team's Activity says so", async () => {
    await seedMove("dmv_in", "target", "done", true);
    await assert.rejects(
      runWithIdentity({ userId: "user_2", teamId: TEAM_A }, () =>
        resumeMoveSchedules(),
      ),
      /Only an instance admin/,
    );
    assert.equal(await schedulesPaused(), true);

    await runWithIdentity({ userId: USER_1, teamId: TEAM_A }, () =>
      resumeMoveSchedules(),
    );
    assert.equal(await schedulesPaused(), false, "no stale cache");
    for (const team of [TEAM_A, TEAM_B])
      assert.deepEqual(await activityFor(team), [
        {
          message: "Turned on scheduled jobs and backups after the move",
          actor: USER_1,
        },
      ]);

    await runWithIdentity({ userId: USER_1, teamId: TEAM_A }, () =>
      resumeMoveSchedules(),
    );
    assert.equal((await activityFor(TEAM_A)).length, 1, "nothing to turn on");
  });
});
