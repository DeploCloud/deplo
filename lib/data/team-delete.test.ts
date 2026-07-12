import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import {
  memberships as membershipsTable,
  membershipCapabilities as membershipCapabilitiesTable,
  teams as teamsTable,
} from "../db/schema/control-plane";
import { runWithIdentity } from "../auth/request-context";
import { capabilitiesForRole } from "../membership-shared";
import {
  seedIdentity,
  TRUNCATE_IDENTITY,
  TEAM_A,
  TEAM_B,
  USER_1,
} from "./identity-test-helpers";
import { canDeleteTeam, deleteTeam } from "./team-delete";

/**
 * deleteTeam gating + cascade against pglite. No apps/databases are seeded,
 * so the agent-teardown loop is a no-op and the tests stay hermetic (no gRPC
 * dials). The cookie switch after the delete throws outside a request scope and
 * is best-effort by design — asserted indirectly by the delete succeeding.
 */

const USER_2 = "user_2";

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
  await pg.exec(TRUNCATE_IDENTITY);
});

/** Add an existing user to another team (seedIdentity seeds one membership per user). */
async function addMembership(userId: string, teamId: string, role = "member") {
  const membershipId = `mem_${userId}_${teamId}`;
  await db.insert(membershipsTable).values({
    id: membershipId,
    userId,
    teamId,
    role,
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  await db.insert(membershipCapabilitiesTable).values(
    capabilitiesForRole(role as "owner" | "member" | "viewer").map((c) => ({
      membershipId,
      capability: c,
    })),
  );
}

async function teamExists(teamId: string): Promise<boolean> {
  const rows = await db
    .select({ id: teamsTable.id })
    .from(teamsTable)
    .where(eq(teamsTable.id, teamId));
  return rows.length > 0;
}

test("the founder deletes the team; cascades take the memberships", async () => {
  // USER_1 is TEAM_A's founder (seed default) and needs a second team to pass
  // the only-team guard.
  await seedIdentity(db);
  await addMembership(USER_1, TEAM_B);

  await runWithIdentity({ userId: USER_1, teamId: TEAM_A }, () => deleteTeam(TEAM_A));

  assert.equal(await teamExists(TEAM_A), false);
  assert.equal(await teamExists(TEAM_B), true);
  const memberships = await db
    .select()
    .from(membershipsTable)
    .where(eq(membershipsTable.teamId, TEAM_A));
  assert.equal(memberships.length, 0);
});

test("an assigned owner (not the founder, not an admin) is rejected", async () => {
  await seedIdentity(db, {
    teams: [
      { id: TEAM_A, slug: "alpha" },
      { id: TEAM_B, slug: "beta" },
    ],
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      // Assigned owner: owner ROLE in TEAM_A but not its founder. seedIdentity
      // defaults owners to instance admin, so pin that off — it would bypass
      // the founder gate.
      { id: USER_2, teamId: TEAM_A, role: "owner", isInstanceAdmin: false },
    ],
  });
  await addMembership(USER_2, TEAM_B);

  await assert.rejects(
    runWithIdentity({ userId: USER_2, teamId: TEAM_A }, () => deleteTeam(TEAM_A)),
    /primary owner or an instance admin/,
  );
  assert.equal(await teamExists(TEAM_A), true);
});

test("an instance-admin member who is not the founder may delete", async () => {
  await seedIdentity(db, {
    teams: [
      { id: TEAM_A, slug: "alpha" },
      { id: TEAM_B, slug: "beta" },
    ],
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      { id: USER_2, teamId: TEAM_A, role: "member", isInstanceAdmin: true },
    ],
  });
  await addMembership(USER_2, TEAM_B);

  await runWithIdentity({ userId: USER_2, teamId: TEAM_A }, () => deleteTeam(TEAM_A));
  assert.equal(await teamExists(TEAM_A), false);
});

test("the caller's only team can't be deleted", async () => {
  await seedIdentity(db); // USER_1 is a member of TEAM_A only

  await assert.rejects(
    runWithIdentity({ userId: USER_1, teamId: TEAM_A }, () => deleteTeam(TEAM_A)),
    /only team/,
  );
  assert.equal(await teamExists(TEAM_A), true);
});

test("a teamId that is not the active team fails closed (stale tab)", async () => {
  // The client echoes back the id the user confirmed; if the active team
  // changed meanwhile (another tab switched or created a team), the delete
  // must refuse rather than destroy whatever the cookie now resolves to.
  await seedIdentity(db);
  await addMembership(USER_1, TEAM_B);

  await assert.rejects(
    runWithIdentity({ userId: USER_1, teamId: TEAM_A }, () =>
      deleteTeam(TEAM_B),
    ),
    /no longer the active team/,
  );
  assert.equal(await teamExists(TEAM_A), true);
  assert.equal(await teamExists(TEAM_B), true);
});

test("a bearer token scoped to a team the user left fails closed", async () => {
  // getActiveTeamId silently rescopes a stale token to the user's first team;
  // deleteTeam must refuse that rescope instead of deleting a team the token
  // was never scoped to. USER_1 founded TEAM_A but is NOT a member of TEAM_B —
  // an identity claiming TEAM_B resolves to TEAM_A via the fallback.
  await seedIdentity(db);

  await assert.rejects(
    runWithIdentity({ userId: USER_1, teamId: TEAM_B }, () =>
      deleteTeam(TEAM_A),
    ),
    /scoped to a team the user no longer belongs to/,
  );
  assert.equal(await teamExists(TEAM_A), true);
});

test("on a legacy team with no founder, any owner may delete", async () => {
  await seedIdentity(db, {
    teams: [
      { id: TEAM_A, slug: "alpha", founderUserId: null },
      { id: TEAM_B, slug: "beta" },
    ],
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner", isInstanceAdmin: false },
    ],
  });
  await addMembership(USER_1, TEAM_B);

  await runWithIdentity({ userId: USER_1, teamId: TEAM_A }, () => deleteTeam(TEAM_A));
  assert.equal(await teamExists(TEAM_A), false);
});

test("a team with a database, an S3 destination, schedules and run history deletes cleanly", async () => {
  // The riskiest cascade topology: backups/backup_runs point at s3_destination
  // with ON DELETE RESTRICT while the team delete cascades BOTH sides in one
  // statement. Postgres' RI checks run on the end-of-statement snapshot, so the
  // single DELETE must survive — this guards the invariant against future
  // schema changes. The seeded server has no agent, so the database teardown
  // exercises the best-effort path (unreachable → warn → proceed).
  await seedIdentity(db);
  await addMembership(USER_1, TEAM_B);
  const T0 = "2026-01-01T00:00:00.000Z";
  await pg.exec(`
    insert into servers (id, name, host, type, status, ip, docker_version, traefik_enabled, cpu_cores, memory_mb, disk_gb, cpu_usage, memory_usage, disk_usage, created_at)
      values ('srv_1', 's', 'h', 'remote', 'online', '1.2.3.4', 'x', true, 1, 1, 1, 0, 0, 0, '${T0}')
      on conflict do nothing;
    insert into databases (id, team_id, name, type, version, username, db_name, status, server_id, host, port, connection_string_enc, exposed_publicly, size_mb, created_at)
      values ('db_x', '${TEAM_A}', 'd', 'postgres', '16', 'app', 'app', 'running', 'srv_1', 'db-d', 5432, 'enc', false, 0, '${T0}');
    insert into s3_destination (id, team_id, name, provider, endpoint, region, bucket, access_key_enc, secret_key_enc, status, created_at)
      values ('s3_1', '${TEAM_A}', 'dest', 'aws', 'e', 'r', 'b', 'a', 's', 'connected', '${T0}');
    insert into backups (id, team_id, name, target_kind, database_id, app_id, destination_id, schedule, retention_days, last_status, enabled, created_at)
      values ('bak_1', '${TEAM_A}', 'nightly', 'database', 'db_x', null, 's3_1', '0 3 * * *', 7, 'never', true, '${T0}');
    insert into backup_runs (id, team_id, backup_id, target_kind, database_id, app_id, destination_id, object_key, size_bytes, status, started_at)
      values ('run_1', '${TEAM_A}', 'bak_1', 'database', 'db_x', null, 's3_1', 'k', 1, 'success', '${T0}');
  `);

  await runWithIdentity({ userId: USER_1, teamId: TEAM_A }, () => deleteTeam(TEAM_A));

  assert.equal(await teamExists(TEAM_A), false);
  for (const [table, id] of [
    ["databases", "db_x"],
    ["s3_destination", "s3_1"],
    ["backups", "bak_1"],
    ["backup_runs", "run_1"],
  ]) {
    const left = await pg.query(`select id from ${table} where id = '${id}'`);
    assert.equal(left.rows.length, 0, `${table} row survived the delete`);
  }
});

test("canDeleteTeam reports the gate and the only-team guard", async () => {
  await seedIdentity(db, {
    teams: [
      { id: TEAM_A, slug: "alpha" },
      { id: TEAM_B, slug: "beta" },
    ],
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      { id: USER_2, teamId: TEAM_A, role: "member", isInstanceAdmin: false },
    ],
  });

  // Founder of their only team: allowed but blocked by the guard.
  assert.deepEqual(
    await runWithIdentity({ userId: USER_1, teamId: TEAM_A }, () =>
      canDeleteTeam(),
    ),
    { allowed: true, onlyTeam: true },
  );

  // With a second team the guard lifts.
  await addMembership(USER_1, TEAM_B);
  assert.deepEqual(
    await runWithIdentity({ userId: USER_1, teamId: TEAM_A }, () =>
      canDeleteTeam(),
    ),
    { allowed: true, onlyTeam: false },
  );

  // A plain member is never allowed.
  assert.deepEqual(
    await runWithIdentity({ userId: USER_2, teamId: TEAM_A }, () =>
      canDeleteTeam(),
    ),
    { allowed: false, onlyTeam: true },
  );
});
