import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import {
  folders as foldersTable,
  projects as projectsTable,
} from "../db/schema/control-plane";
import { runWithIdentity } from "../auth/request-context";
import { seedIdentity, TEAM_A, TEAM_B, USER_1 } from "./identity-test-helpers";
import { TRUNCATE_INFRA, seedActivity } from "./infra-test-helpers";
import {
  TRUNCATE_PROJECT_GRAPH,
  seedApp,
  seedServer,
} from "./app-graph-test-helpers";
import {
  ACTOR_SYSTEM,
  activityMonths,
  listActivity,
  listActivityActors,
  recordActivity,
  type ActivityFilter,
} from "./activity";

/**
 * The Activity feed's keyset paging and its filters. The filters exist to NARROW
 * a trail, so the first thing asserted is that none of them can widen one.
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

const T0 = "2026-01-01T00:00:00.000Z";
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

/** Walk the whole feed `size` rows at a time, following the keyset cursor. */
async function pageThrough(
  size: number,
  filter: ActivityFilter = {},
): Promise<string[]> {
  const ids: string[] = [];
  let cursor: ActivityFilter["cursor"];
  for (;;) {
    const page = await listActivity(size, { ...filter, cursor });
    ids.push(...page.map((a) => a.id));
    if (page.length < size) return ids;
    const last = page[page.length - 1]!;
    cursor = { createdAt: last.createdAt, seq: last.seq };
  }
}

/* ------------------------------------------------------------------ */
/* keyset paging                                                       */
/* ------------------------------------------------------------------ */

test("paging: the cursor walks a same-instant tie without skipping or repeating", async () => {
  // Five rows sharing ONE timestamp: only `seq` separates them, which is the
  // whole reason the cursor is a tuple and not a date.
  for (let i = 1; i <= 5; i++)
    await seedActivity(db, { id: `act_${i}`, teamId: TEAM_A, createdAt: T0 });

  await asUser1(async () => {
    const ids = await pageThrough(2);
    assert.deepEqual(
      ids,
      ["act_5", "act_4", "act_3", "act_2", "act_1"],
      "every row exactly once, newest-first",
    );
  });
});

test("paging: the cursor crosses a timestamp boundary cleanly", async () => {
  await seedActivity(db, { id: "act_old", teamId: TEAM_A, createdAt: MAY });
  await seedActivity(db, { id: "act_a", teamId: TEAM_A, createdAt: AUG });
  await seedActivity(db, { id: "act_b", teamId: TEAM_A, createdAt: AUG });

  await asUser1(async () => {
    assert.deepEqual(await pageThrough(2), ["act_b", "act_a", "act_old"]);
    // A page size that lands exactly on the boundary is the case that repeats a
    // row when the cursor only compares the timestamp.
    assert.deepEqual(await pageThrough(1), ["act_b", "act_a", "act_old"]);
  });
});

test("paging: a cursor never reaches another team's rows", async () => {
  await seedActivity(db, { id: "act_a", teamId: TEAM_A, createdAt: AUG });
  await seedActivity(db, { id: "act_b", teamId: TEAM_B, createdAt: AUG });
  await asUser1(async () => {
    assert.deepEqual(await pageThrough(1), ["act_a"]);
  });
});

/* ------------------------------------------------------------------ */
/* filters                                                             */
/* ------------------------------------------------------------------ */

test("filters: types keeps only the picked kinds", async () => {
  await seedActivity(db, { id: "a_app", teamId: TEAM_A, type: "app" });
  await seedActivity(db, { id: "a_sec", teamId: TEAM_A, type: "security" });
  await seedActivity(db, { id: "a_srv", teamId: TEAM_A, type: "server" });

  await asUser1(async () => {
    const list = await listActivity(50, { types: ["security", "server"] });
    assert.deepEqual(
      new Set(list.map((a) => a.id)),
      new Set(["a_sec", "a_srv"]),
    );
  });
});

test("filters: actorUserIds picks people, and ACTOR_SYSTEM picks what has none", async () => {
  await seedActivity(db, {
    id: "a_me",
    teamId: TEAM_A,
    actor: "Ada",
    actorUserId: USER_1,
  });
  await seedActivity(db, {
    id: "a_sys",
    teamId: TEAM_A,
    actor: "Deplo",
    actorUserId: null,
  });

  await asUser1(async () => {
    assert.deepEqual(
      (await listActivity(50, { actorUserIds: [USER_1] })).map((a) => a.id),
      ["a_me"],
    );
    assert.deepEqual(
      (await listActivity(50, { actorUserIds: [ACTOR_SYSTEM] })).map(
        (a) => a.id,
      ),
      ["a_sys"],
    );
    // Both together is a union, not an intersection.
    assert.equal(
      (await listActivity(50, { actorUserIds: [USER_1, ACTOR_SYSTEM] })).length,
      2,
    );
  });
});

test("filters: from is inclusive and to is exclusive at the instant", async () => {
  await seedActivity(db, { id: "a_may", teamId: TEAM_A, createdAt: MAY });
  await seedActivity(db, { id: "a_aug", teamId: TEAM_A, createdAt: AUG });

  await asUser1(async () => {
    assert.deepEqual(
      (await listActivity(50, { from: MAY })).map((a) => a.id),
      ["a_aug", "a_may"],
      "from includes the row at the boundary",
    );
    assert.deepEqual(
      (await listActivity(50, { to: AUG })).map((a) => a.id),
      ["a_may"],
      "to excludes the row at the boundary",
    );
  });
});

test("filters: resourceIds resolves an app, its folder and its project", async () => {
  await seedServer(db);
  await db.insert(foldersTable).values({
    id: "fld_1",
    teamId: TEAM_A,
    name: "Team",
    createdAt: T0,
    updatedAt: T0,
  });
  await db.insert(projectsTable).values({
    id: "prc_1",
    teamId: TEAM_A,
    name: "Platform",
    slug: "platform",
    createdAt: T0,
    updatedAt: T0,
  });
  await seedApp(db, { id: "prj_in", folderId: "fld_1", projectId: "prc_1" });
  await seedApp(db, { id: "prj_out" });

  await seedActivity(db, { id: "a_in", teamId: TEAM_A, appId: "prj_in" });
  await seedActivity(db, { id: "a_out", teamId: TEAM_A, appId: "prj_out" });
  await seedActivity(db, { id: "a_team", teamId: TEAM_A, appId: null });

  await asUser1(async () => {
    for (const [what, id] of [
      ["the app itself", "prj_in"],
      ["its folder", "fld_1"],
      ["its project", "prc_1"],
    ] as const)
      assert.deepEqual(
        (await listActivity(50, { resourceIds: [id] })).map((a) => a.id),
        ["a_in"],
        `${what} reaches the app's rows, and nothing else`,
      );
    // Deliberate: a team-level row belongs to no app, so asking about an app
    // hides it. Same rule the role scope already applies.
    assert.equal(
      (await listActivity(50, { resourceIds: ["prj_in"] })).some(
        (a) => a.id === "a_team",
      ),
      false,
    );
  });
});

test("filters: an unknown resource id matches nothing rather than everything", async () => {
  await seedActivity(db, { id: "a_1", teamId: TEAM_A });
  await asUser1(async () => {
    assert.deepEqual(await listActivity(50, { resourceIds: ["prj_nope"] }), []);
  });
});

test("filters: another team's app id reaches none of this team's rows", async () => {
  await seedServer(db);
  await seedApp(db, { id: "prj_b", teamId: TEAM_B });
  await seedActivity(db, { id: "a_a", teamId: TEAM_A, appId: null });
  await asUser1(async () => {
    assert.deepEqual(await listActivity(50, { resourceIds: ["prj_b"] }), []);
  });
});

/* ------------------------------------------------------------------ */
/* month counts and the actor list                                     */
/* ------------------------------------------------------------------ */

test("activityMonths: buckets in UTC whatever the session timezone is", async () => {
  await seedActivity(db, { id: "a_1", teamId: TEAM_A, createdAt: MAY });
  await seedActivity(db, { id: "a_2", teamId: TEAM_A, createdAt: AUG });
  await seedActivity(db, { id: "a_3", teamId: TEAM_A, createdAt: AUG });
  await seedActivity(db, { id: "a_b", teamId: TEAM_B, createdAt: AUG });

  await asUser1(async () => {
    const expected = [
      { month: "2026-08", count: 2 },
      { month: "2026-05", count: 1 },
    ];
    assert.deepEqual(await activityMonths(), expected);
    // A raw timestamptz expression renders in the SESSION's zone, which is why
    // the query says `at time zone` instead of trusting the default.
    await pg.exec("set time zone 'Etc/GMT-1'");
    assert.deepEqual(await activityMonths(), expected);
    await pg.exec("set time zone 'UTC'");
  });
});

test("activityMonths: honours the same filters as the feed", async () => {
  await seedActivity(db, {
    id: "a_1",
    teamId: TEAM_A,
    createdAt: AUG,
    type: "app",
  });
  await seedActivity(db, {
    id: "a_2",
    teamId: TEAM_A,
    createdAt: AUG,
    type: "server",
  });
  await asUser1(async () => {
    assert.deepEqual(await activityMonths({ types: ["server"] }), [
      { month: "2026-08", count: 1 },
    ]);
  });
});

test("listActivityActors: one row per person, one bucket for everything else", async () => {
  await seedActivity(db, {
    id: "a_1",
    teamId: TEAM_A,
    actor: "Ada",
    actorUserId: USER_1,
  });
  await seedActivity(db, {
    id: "a_2",
    teamId: TEAM_A,
    actor: "Ada",
    actorUserId: USER_1,
  });
  await seedActivity(db, { id: "a_3", teamId: TEAM_A, actor: "Deplo" });
  await seedActivity(db, { id: "a_4", teamId: TEAM_A, actor: "github" });
  await seedActivity(db, { id: "a_b", teamId: TEAM_B, actor: "Other" });

  await asUser1(async () => {
    const actors = await listActivityActors();
    assert.deepEqual(
      actors.map((a) => a.value),
      [USER_1, ACTOR_SYSTEM],
      "the person once, everything faceless folded into one option, last",
    );
    assert.equal(actors[1]!.label, "System");
  });
});

/* ------------------------------------------------------------------ */
/* the four new types                                                  */
/* ------------------------------------------------------------------ */

test("types: the four types split out of `member` survive the round trip", async () => {
  await asUser1(async () => {
    for (const type of [
      "security",
      "server",
      "integration",
      "instance",
    ] as const)
      await recordActivity(type, `did ${type}`, "owner", null, TEAM_A);
    const list = await listActivity(50);
    assert.deepEqual(
      new Set(list.map((a) => a.type)),
      new Set(["security", "server", "integration", "instance"]),
    );
  });
});
