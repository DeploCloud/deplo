import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { runWithIdentity } from "../auth/request-context";
import { seedIdentity, TEAM_A, TEAM_B, USER_1 } from "./identity-test-helpers";
import {
  seedServer,
  seedService,
  SERVER_1,
  TRUNCATE_PROJECT_GRAPH,
} from "./service-graph-test-helpers";
import { seedDatabase } from "./backup-test-helpers";
import {
  listServersForTeam,
  setServerTeams,
  getServerTeamIds,
  getServerById,
} from "./servers";

/**
 * Data-layer tests for server → team access (the "all teams / specific teams"
 * feature). Covers the consumption filter (`listServersForTeam`), the
 * `setServerTeams` widen/restrict transitions, and the block that refuses to
 * revoke a team's access while it still has workloads (services or databases) on
 * the server — the conscious-teardown rule mirrored from `removeServer`.
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

beforeEach(async () => {
  // Truncating `servers` cascades to `server_teams` and `databases`; truncating
  // `teams` cascades to the rest of identity — so each test starts from scratch.
  await pg.exec(`${TRUNCATE_PROJECT_GRAPH}
    truncate table registration_links, membership_capabilities, memberships, users, teams restart identity cascade;`);
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      { id: "user_2", teamId: TEAM_B, role: "owner" },
      { id: "user_member", teamId: TEAM_A, role: "member" },
    ],
  });
  await seedServer(db); // SERVER_1, all_teams defaults to true
});

const asUser1 = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);

const has = (servers: { id: string }[], id: string): boolean =>
  servers.some((s) => s.id === id);

test("an all_teams server is visible to every team", async () => {
  assert.ok(has(await listServersForTeam(TEAM_A), SERVER_1));
  assert.ok(has(await listServersForTeam(TEAM_B), SERVER_1));
});

test("setServerTeams restricts the server to the selected teams only", async () => {
  await asUser1(() =>
    setServerTeams(SERVER_1, { allTeams: false, teamIds: [TEAM_A] }),
  );

  assert.ok(has(await listServersForTeam(TEAM_A), SERVER_1), "granted team sees it");
  assert.ok(
    !has(await listServersForTeam(TEAM_B), SERVER_1),
    "excluded team does not",
  );
  assert.deepEqual(await getServerTeamIds(SERVER_1), [TEAM_A]);
  assert.equal((await getServerById(SERVER_1))!.allTeams, false);
});

test("widening back to all teams clears the specific grants", async () => {
  await asUser1(() =>
    setServerTeams(SERVER_1, { allTeams: false, teamIds: [TEAM_A] }),
  );
  await asUser1(() => setServerTeams(SERVER_1, { allTeams: true, teamIds: [] }));

  assert.equal((await getServerById(SERVER_1))!.allTeams, true);
  assert.deepEqual(await getServerTeamIds(SERVER_1), []);
  assert.ok(has(await listServersForTeam(TEAM_B), SERVER_1));
});

test("setServerTeams dedupes team ids", async () => {
  await asUser1(() =>
    setServerTeams(SERVER_1, { allTeams: false, teamIds: [TEAM_A, TEAM_A] }),
  );
  assert.deepEqual(await getServerTeamIds(SERVER_1), [TEAM_A]);
});

test("restricting is BLOCKED when an excluded team has a PROJECT on the server", async () => {
  await seedService(db, { id: "prj_b", teamId: TEAM_B, serverId: SERVER_1 });

  await assert.rejects(
    asUser1(() =>
      setServerTeams(SERVER_1, { allTeams: false, teamIds: [TEAM_A] }),
    ),
    /services or databases/,
  );
  // The block left the access untouched (still all teams).
  assert.equal((await getServerById(SERVER_1))!.allTeams, true);
});

test("restricting is BLOCKED when an excluded team has a DATABASE on the server", async () => {
  await seedDatabase(db, { id: "db_b", teamId: TEAM_B, serverId: SERVER_1 });

  await assert.rejects(
    asUser1(() =>
      setServerTeams(SERVER_1, { allTeams: false, teamIds: [TEAM_A] }),
    ),
    /services or databases/,
  );
});

test("restricting SUCCEEDS when the team with workloads stays included", async () => {
  await seedService(db, { id: "prj_b", teamId: TEAM_B, serverId: SERVER_1 });

  await asUser1(() =>
    setServerTeams(SERVER_1, { allTeams: false, teamIds: [TEAM_A, TEAM_B] }),
  );
  assert.deepEqual(
    [...(await getServerTeamIds(SERVER_1))].sort(),
    [TEAM_A, TEAM_B].sort(),
  );
});

test("setServerTeams requires instance admin", async () => {
  // user_member is a plain team member (not an instance admin) — server
  // administration is instance-admin-only, so the mutation must reject.
  await assert.rejects(
    runWithIdentity({ userId: "user_member", teamId: TEAM_A }, () =>
      setServerTeams(SERVER_1, { allTeams: false, teamIds: [TEAM_A] }),
    ),
    /instance admin/i,
  );
});
