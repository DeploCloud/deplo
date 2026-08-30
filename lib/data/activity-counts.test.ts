// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { runWithIdentity } from "../auth/request-context";
import { seedIdentity, TEAM_A, TEAM_B, USER_1 } from "./identity-test-helpers";
import { TRUNCATE_INFRA, seedActivity } from "./infra-test-helpers";
import { TRUNCATE_PROJECT_GRAPH } from "./app-graph-test-helpers";
import {
  ACTOR_SYSTEM,
  activityCountsByActor,
  activityCountsByType,
} from "./activity";

/**
 * The counts beside the Activity feed. They drive filter links, so the thing that
 * matters is that they can never describe a row the reader cannot open.
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

const MAY = "2026-05-10T12:00:00.000Z";
const AUG = "2026-08-10T12:00:00.000Z";

beforeEach(async () => {
  await pg.exec(`${TRUNCATE_PROJECT_GRAPH}
    ${TRUNCATE_INFRA}
    truncate table users, teams restart identity cascade;`);
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      { id: "user_2", teamId: TEAM_B, role: "owner" },
    ],
  });
});

const asUser1 = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);

test("counts by type: this team only, busiest first", async () => {
  await seedActivity(db, { id: "a_1", teamId: TEAM_A, type: "app" });
  await seedActivity(db, { id: "a_2", teamId: TEAM_A, type: "app" });
  await seedActivity(db, { id: "a_3", teamId: TEAM_A, type: "server" });
  await seedActivity(db, { id: "a_b", teamId: TEAM_B, type: "server" });

  await asUser1(async () => {
    assert.deepEqual(await activityCountsByType(), [
      { type: "app", count: 2 },
      { type: "server", count: 1 },
    ]);
  });
});

test("counts by actor: everything non-human in the one system bucket", async () => {
  await seedActivity(db, { id: "a_1", teamId: TEAM_A, actorUserId: USER_1 });
  await seedActivity(db, { id: "a_2", teamId: TEAM_A, actorUserId: USER_1 });
  await seedActivity(db, { id: "a_3", teamId: TEAM_A, actor: "Deplo" });
  await seedActivity(db, { id: "a_4", teamId: TEAM_A, actor: "system" });
  await seedActivity(db, { id: "a_b", teamId: TEAM_B, actorUserId: "user_2" });

  await asUser1(async () => {
    assert.deepEqual(await activityCountsByActor(), [
      { actorUserId: ACTOR_SYSTEM, count: 2 },
      { actorUserId: USER_1, count: 2 },
    ]);
  });
});

test("counts honour the window", async () => {
  await seedActivity(db, { id: "a_1", teamId: TEAM_A, createdAt: MAY });
  await seedActivity(db, { id: "a_2", teamId: TEAM_A, createdAt: AUG });

  await asUser1(async () => {
    assert.deepEqual(await activityCountsByType({ from: "2026-08-01" }), [
      { type: "app", count: 1 },
    ]);
  });
});

test("counts stay blind to their own dimension", async () => {
  await seedActivity(db, {
    id: "a_1",
    teamId: TEAM_A,
    type: "app",
    actorUserId: USER_1,
  });
  await seedActivity(db, {
    id: "a_2",
    teamId: TEAM_A,
    type: "server",
    actorUserId: USER_1,
  });
  await seedActivity(db, { id: "a_3", teamId: TEAM_A, type: "app" });

  await asUser1(async () => {
    // The page passes its own dimension empty: picking a person narrows the
    // events beside them, and never collapses the people to a list of one.
    assert.deepEqual(
      await activityCountsByType({ actorUserIds: [USER_1], types: [] }),
      [
        { type: "app", count: 1 },
        { type: "server", count: 1 },
      ],
    );
    assert.deepEqual(
      await activityCountsByActor({ types: ["app"], actorUserIds: [] }),
      // Tied, so the key decides - and it decides the same way every render.
      [
        { actorUserId: ACTOR_SYSTEM, count: 1 },
        { actorUserId: USER_1, count: 1 },
      ],
    );
  });
});
