import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { apps as appsTable } from "../db/schema/control-plane";
import { seedIdentity, TEAM_A, TEAM_B, USER_1 } from "./identity-test-helpers";
import { seedApp, seedServer } from "./app-graph-test-helpers";
import { seedDatabase } from "./backup-test-helpers";
import { runWithIdentity } from "../auth/request-context";
import { listApps } from "./apps";
import { search } from "./search";

/**
 * The one read that spans teams.
 */

let db: TestDb;
let pg: PGlite;

/** Seeded, with an app in it, and USER_1 is not a member. */
const TEAM_C = "team_c";

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
});

after(async () => {
  __resetTestDb();
  await pg.close();
});

beforeEach(async () => {
  await pg.exec(
    `DO $$ DECLARE r record; BEGIN
       FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public') LOOP
         EXECUTE format('truncate table public.%I restart identity cascade', r.tablename);
       END LOOP; END $$;`,
  );
  await seedIdentity(db, {
    teams: [
      { id: TEAM_A, slug: "alpha" },
      { id: TEAM_B, slug: "beta" },
      { id: TEAM_C, slug: "gamma" },
    ],
  });
  // The same person in two of the three teams. Without the second membership
  // every assertion below would pass for the wrong reason.
  await pg.query(
    `insert into memberships (id, user_id, team_id, role, created_at)
     values ('mem_user_1_b', $1, $2, 'owner', '2026-01-01T00:00:00.000Z')`,
    [USER_1, TEAM_B],
  );
  await pg.query(
    `insert into membership_capabilities (membership_id, capability)
     select 'mem_user_1_b', capability from membership_capabilities
     where membership_id = 'mem_user_1'`,
  );

  await seedServer(db);
  await seedApp(db, { id: "prj_a1", teamId: TEAM_A, slug: "better-auth-docs" });
  await seedApp(db, { id: "prj_b1", teamId: TEAM_B, slug: "quotedb-api" });
  await seedApp(db, {
    id: "prj_c1",
    teamId: TEAM_C,
    slug: "better-auth-private",
  });
  // `seedApp` names an app after its id; the display name is what a person
  // actually types, so give one app a real one.
  await db
    .update(appsTable)
    .set({ name: "Better Auth Docs" })
    .where(eq(appsTable.id, "prj_a1"));
  await seedDatabase(db, {
    id: "db_b1",
    name: "better-auth-store",
    teamId: TEAM_B,
  });
});

const asUser1 = <T>(fn: () => Promise<T>) =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);

test("finds hits in another team and stamps each with the team it is in", async () => {
  const found = await asUser1(() => search("better auth"));

  assert.deepEqual(
    found.apps.map((a) => [a.id, a.team.slug]),
    [["prj_a1", "alpha"]],
    "the app in the active team, with its team",
  );
  assert.deepEqual(
    found.databases.map((d) => [d.id, d.team.slug]),
    [["db_b1", "beta"]],
    "a database in ANOTHER team is found, and says which",
  );
});

test("a team the caller is not a member of contributes nothing", async () => {
  // `better-auth-private` matches the query as well as anything in alpha does.
  // It must be absent because the search never enters gamma at all.
  const found = await asUser1(() => search("better"));
  const ids = found.apps.map((a) => a.id);

  assert.ok(ids.includes("prj_a1"), ids.join());
  assert.ok(!ids.includes("prj_c1"), `gamma leaked: ${ids.join()}`);
});

test("case, separators and ids are all one match rule", async () => {
  const bySpaces = await asUser1(() => search("BETTER auth docs"));
  assert.deepEqual(
    bySpaces.apps.map((a) => a.id),
    ["prj_a1"],
  );

  // A pasted id finds its app in whichever team holds it.
  const byId = await asUser1(() => search("prj_b1"));
  assert.deepEqual(
    byId.apps.map((a) => [a.id, a.team.slug]),
    [["prj_b1", "beta"]],
  );

  const blank = await asUser1(() => search("   "));
  assert.deepEqual(blank, { apps: [], databases: [] }, "blank finds nothing");
});

test("the same match filters one team's list", async () => {
  // `listApps(q)` and `search` have to agree about what a hit is, so the
  // in-team filter is the same rule and not a second one.
  const here = await asUser1(() => listApps("better auth"));
  assert.deepEqual(
    here.map((a) => a.id),
    ["prj_a1"],
  );

  const there = await runWithIdentity({ userId: USER_1, teamId: TEAM_B }, () =>
    listApps("better auth"),
  );
  assert.deepEqual(there, [], "the filter never reaches outside the team");
});
