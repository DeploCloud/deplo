import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { PGlite } from "@electric-sql/pglite";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { runWithIdentity } from "../auth/request-context";
import {
  seedIdentity,
  TRUNCATE_IDENTITY,
  TEAM_A,
  TEAM_B,
  USER_1,
} from "./identity-test-helpers";
import {
  seedApp,
  seedServer,
  TRUNCATE_PROJECT_GRAPH,
} from "./app-graph-test-helpers";
import { seedDatabase } from "./backup-test-helpers";
import { memberships as membershipsTable } from "../db/schema/control-plane/access-control";
import { myTeamSlugOwning } from "./teams";

let db: TestDb;
let pg: PGlite;
const USER_2 = "user_2";

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
});

after(async () => {
  __resetTestDb();
  await pg.close();
});

beforeEach(async () => {
  await db.execute(TRUNCATE_PROJECT_GRAPH);
  await db.execute(TRUNCATE_IDENTITY);
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      { id: USER_2, teamId: TEAM_B, role: "owner" },
    ],
  });
  await db.insert(membershipsTable).values({
    id: `mem_${USER_1}_${TEAM_B}`,
    userId: USER_1,
    teamId: TEAM_B,
    role: "member",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  await seedServer(db);
  await seedApp(db, { id: "prj_a", slug: "web", teamId: TEAM_A });
  await seedApp(db, { id: "prj_b", slug: "shop", teamId: TEAM_B });
  await seedDatabase(db, { id: "db_b", name: "main", teamId: TEAM_B });
});

const asUser1 = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);

test("an app names the team that owns it, not the active one", async () => {
  await asUser1(async () => {
    assert.equal(await myTeamSlugOwning("app", "web"), "alpha");
    assert.equal(await myTeamSlugOwning("app", "shop"), "beta");
    assert.equal(await myTeamSlugOwning("database", "db_b"), "beta");
  });
});

test("a resource in a team the viewer is not in names nothing", async () => {
  await runWithIdentity({ userId: USER_2, teamId: TEAM_B }, async () => {
    assert.equal(await myTeamSlugOwning("app", "web"), null);
    assert.equal(await myTeamSlugOwning("app", "shop"), "beta");
  });
});

test("an unknown resource names nothing", async () => {
  await asUser1(async () => {
    assert.equal(await myTeamSlugOwning("app", "gone"), null);
    assert.equal(await myTeamSlugOwning("database", "db_gone"), null);
  });
});
