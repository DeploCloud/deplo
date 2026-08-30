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
import { runWithIdentity, type TokenGrant } from "../auth/request-context";
import { ALL_CAPABILITIES } from "../types";
import { listApps } from "./apps";
import { search, type SearchKind } from "./search";

/**
 * The one read that spans teams.
 */

let db: TestDb;
let pg: PGlite;

/** Every kind but `template`: the catalogue is a real HTTP fetch, and the suite
 *  must not go to the network. */
const KINDS: SearchKind[] = [
  "app",
  "database",
  "server",
  "project",
  "environment",
  "folder",
  "domain",
  "member",
  "cron",
];

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
  const found = await asUser1(() => search("better auth", KINDS));

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
  const found = await asUser1(() => search("better", KINDS));
  const ids = found.apps.map((a) => a.id);

  assert.ok(ids.includes("prj_a1"), ids.join());
  assert.ok(!ids.includes("prj_c1"), `gamma leaked: ${ids.join()}`);
});

test("case, separators and ids are all one match rule", async () => {
  const bySpaces = await asUser1(() => search("BETTER auth docs", KINDS));
  assert.deepEqual(
    bySpaces.apps.map((a) => a.id),
    ["prj_a1"],
  );

  // A pasted id finds its app in whichever team holds it.
  const byId = await asUser1(() => search("prj_b1", KINDS));
  assert.deepEqual(
    byId.apps.map((a) => [a.id, a.team.slug]),
    [["prj_b1", "beta"]],
  );

  const blank = await asUser1(() => search("   ", KINDS));
  assert.deepEqual(
    { apps: blank.apps, databases: blank.databases },
    { apps: [], databases: [] },
    "blank finds nothing",
  );
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

test("hits are ranked exact, then prefix, then substring", async () => {
  await seedApp(db, { id: "prj_api", teamId: TEAM_A, slug: "api" });
  await seedApp(db, { id: "prj_gw", teamId: TEAM_A, slug: "api-gateway" });
  await seedApp(db, { id: "prj_leg", teamId: TEAM_A, slug: "legacy-api" });
  for (const [id, name] of [
    ["prj_api", "api"],
    ["prj_gw", "api-gateway"],
    ["prj_leg", "legacy-api"],
  ] as const) {
    await db.update(appsTable).set({ name }).where(eq(appsTable.id, id));
  }

  const found = await asUser1(() => search("api", ["app"]));
  // Alpha's three by how well they matched, and only then beta's `quotedb-api`:
  // the active team wins before the rank is even consulted.
  assert.deepEqual(
    found.apps.map((a) => a.id),
    ["prj_api", "prj_gw", "prj_leg", "prj_b1"],
  );
});

test("the active team outranks a closer match in another one", async () => {
  // `prj_a1` is "Better Auth Docs" in alpha; `db_b1` is "better-auth-store" in
  // beta. Whichever team the caller is IN comes first.
  const fromAlpha = await asUser1(() =>
    search("better auth", ["app", "database"]),
  );
  assert.deepEqual(
    [
      ...fromAlpha.apps.map((a) => a.team.slug),
      ...fromAlpha.databases.map((d) => d.team.slug),
    ],
    ["alpha", "beta"],
  );

  await seedApp(db, { id: "prj_b2", teamId: TEAM_B, slug: "better-auth-api" });
  const fromBeta = await runWithIdentity(
    { userId: USER_1, teamId: TEAM_B },
    () => search("better auth", ["app"]),
  );
  assert.deepEqual(
    fromBeta.apps.map((a) => a.team.slug),
    ["beta", "alpha"],
    "standing in beta puts beta's hit first",
  );
});

test("a team-wide gate that refuses costs its kind, not the search", async () => {
  // A token narrowed to one app reaches no server, member or database list -
  // every one of those reads throws `requireTeamWide`. The app must still land.
  const grant: TokenGrant = {
    id: "tok_search",
    capabilities: [...ALL_CAPABILITIES],
    scope: {
      teamIds: [TEAM_A],
      wholeTeamIds: [],
      projectIds: [],
      folderIds: [],
      appIds: ["prj_a1"],
      appProjectIds: [],
    },
    instanceAdmin: false,
  };
  const found = await runWithIdentity(
    { userId: USER_1, teamId: TEAM_A, token: grant },
    () => search("better", ["app", "database", "server", "member"]),
  );

  assert.deepEqual(
    found.apps.map((a) => a.id),
    ["prj_a1"],
    "the one app the token names is still found",
  );
  assert.deepEqual(found.databases, [], "databases refused the narrowed token");
  assert.deepEqual(found.servers, [], "servers refused the narrowed token");
  assert.deepEqual(found.members, [], "members refused the narrowed token");
});

test("a role is found by name, in whichever team holds it", () => {
  // `ensureTeamRoles` seeds Owner/Member/Viewer lazily on the first read, so
  // the roles a team has are the ones a person actually sees on its Roles page.
  return asUser1(async () => {
    const found = await search("owner", ["role"]);
    assert.ok(found.roles.length >= 1, "the default Owner role");
    assert.ok(
      found.roles.every((r) => r.name.toLowerCase().includes("owner")),
      found.roles.map((r) => r.name).join(),
    );
    // USER_1 is in alpha and beta, not gamma - and a role is a team's own row,
    // so both teams answer with their own.
    const teams = new Set(found.roles.map((r) => r.team.slug));
    assert.deepEqual([...teams].sort(), ["alpha", "beta"]);
  });
});

test("a member hit carries the picture and never the email", async () => {
  const found = await asUser1(() => search("user", ["member"]));
  assert.ok(found.members.length > 0, "USER_1 is named user_1");
  for (const m of found.members) {
    assert.ok("avatarUrl" in m, "resolved picture, or null for the monogram");
    assert.equal(typeof m.avatarColor, "string");
    assert.ok(
      !JSON.stringify(m).includes("@"),
      `an address leaked into a member hit: ${JSON.stringify(m)}`,
    );
  }
});

test("every team a hit names can be drawn", async () => {
  const found = await asUser1(() => search("better", ["app", "database"]));
  for (const hit of [...found.apps, ...found.databases]) {
    assert.ok(hit.team.id && hit.team.name && hit.team.slug, "named");
    assert.ok("avatarUrl" in hit.team, "and drawable");
  }
});

test("asking for one kind reads only that kind", async () => {
  const found = await asUser1(() => search("better", ["app"]));
  assert.ok(found.apps.length > 0);
  for (const kind of [
    "databases",
    "servers",
    "projects",
    "environments",
    "folders",
    "domains",
    "members",
    "roles",
    "cronJobs",
    "templates",
  ] as const) {
    assert.deepEqual(found[kind], [], kind);
  }
});
