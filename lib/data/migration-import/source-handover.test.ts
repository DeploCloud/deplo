import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { makeTestDb, type TestDb } from "../../db/test-harness";
import { eq } from "drizzle-orm";
import { runWithIdentity } from "../../auth/request-context";
import { servers as serversTable } from "../../db/schema/control-plane/servers";
import { TEAM_A, TEAM_B, USER_1 } from "../identity-test-helpers";
import { SERVER_1 } from "../app-graph-test-helpers";
import { beginMigration, finishMigration } from "./run-lifecycle";
import { abandonMigration, handOverMigrationSources } from "./source-agents";
import { addServer } from "../servers/enrollment";
import {
  URL_BASE,
  USER_2,
  USER_4,
  asOwner,
  asViewerAdmin,
  inBothTeams,
  openMigrationHarness,
  closeMigrationHarness,
  resetMigrationHarness,
} from "./migration-import-test-helpers";

let db: TestDb;
let pg: PGlite;

before(async () => {
  ({ db, pg } = await makeTestDb());
  await openMigrationHarness(db);
});

after(() => closeMigrationHarness(db, pg));

beforeEach(() => resetMigrationHarness(db));

test("a change of target team takes the panel's machines with it", async () => {
  await inBothTeams(db, "mem_1_b", USER_1, ["view", "create_projects"]);
  const { server: source } = await asOwner(() =>
    addServer({
      name: "dokploy-host",
      host: "203.0.113.77",
      importOnly: true,
    }),
  );

  const moved = await runWithIdentity({ userId: USER_1, teamId: TEAM_B }, () =>
    handOverMigrationSources(TEAM_A),
  );

  assert.equal(moved, 1);
  const grants = await db.execute(
    `select team_id from server_teams where server_id = '${source.id}'`,
  );
  assert.deepEqual(
    grants.rows.map((r) => r.team_id),
    [TEAM_B],
  );
  const untouched = await db.execute(
    `select count(*)::int as n from server_teams where server_id = '${SERVER_1}' and team_id = '${TEAM_B}'`,
  );
  assert.equal(untouched.rows[0].n, 0);
});

test("a queued run's machines can still be handed to the next team", async () => {
  await inBothTeams(db, "mem_1_b", USER_1, ["view", "create_projects"]);
  const { server: source } = await asOwner(() =>
    addServer({
      name: "dokploy-host",
      host: "203.0.113.79",
      importOnly: true,
    }),
  );
  const runId = await asOwner(() =>
    beginMigration({ url: URL_BASE, keepSources: true }),
  );
  await asOwner(() => finishMigration(runId));

  const moved = await runWithIdentity({ userId: USER_1, teamId: TEAM_B }, () =>
    handOverMigrationSources(TEAM_A),
  );

  assert.equal(moved, 1);
  const grants = await db.execute(
    `select team_id from server_teams where server_id = '${source.id}'`,
  );
  assert.deepEqual(
    grants.rows.map((r) => r.team_id),
    [TEAM_B],
  );
});

test("a machine only pencilled in for removal is claimed back", async () => {
  await inBothTeams(db, "mem_1_b", USER_1, ["view", "create_projects"]);
  const { server: source } = await asOwner(() =>
    addServer({
      name: "dokploy-host",
      host: "203.0.113.81",
      importOnly: true,
    }),
  );
  assert.equal(await asOwner(() => abandonMigration()), 1);

  const moved = await runWithIdentity({ userId: USER_1, teamId: TEAM_B }, () =>
    handOverMigrationSources(TEAM_A),
  );

  assert.equal(moved, 1);
  const [row] = await db
    .select()
    .from(serversTable)
    .where(eq(serversTable.id, source.id));
  assert.equal(
    row?.uninstallNextAt ?? null,
    null,
    "the reaper would have taken the agent off mid-run",
  );
});

test("a machine cannot be taken out of a team you may not migrate in", async () => {
  await db.execute(
    `delete from membership_capabilities where membership_id = 'mem_${USER_2}' and capability = 'create_projects'`,
  );
  await inBothTeams(db, "mem_2_b", USER_2, ["view", "create_projects"]);
  const { server: source } = await asOwner(() =>
    addServer({
      name: "dokploy-host",
      host: "203.0.113.78",
      importOnly: true,
    }),
  );

  await assert.rejects(
    runWithIdentity({ userId: USER_2, teamId: TEAM_B }, () =>
      handOverMigrationSources(TEAM_A),
    ),
    /cannot move a migration source out of that team/,
  );
  const grants = await db.execute(
    `select team_id from server_teams where server_id = '${source.id}'`,
  );
  assert.deepEqual(
    grants.rows.map((r) => r.team_id),
    [TEAM_A],
  );
});

test("an instance admin moves the machines their page registered", async () => {
  const { server: source } = await asViewerAdmin(() =>
    addServer({
      name: "dokploy-host",
      host: "203.0.113.77",
      importOnly: true,
    }),
  );
  await inBothTeams(db, "mem_4_b", USER_4, ["view", "create_projects"]);

  const moved = await runWithIdentity({ userId: USER_4, teamId: TEAM_B }, () =>
    handOverMigrationSources(TEAM_A),
  );
  assert.equal(moved, 1);
  const grants = await db.execute(
    `select team_id from server_teams where server_id = '${source.id}'`,
  );
  assert.deepEqual(
    grants.rows.map((r) => r.team_id),
    [TEAM_B],
  );
});
