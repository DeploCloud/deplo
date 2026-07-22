import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import {
  apps as appsTable,
  folders as foldersTable,
  instanceSettings,
  memberships as membershipsTable,
  membershipCapabilities as membershipCapabilitiesTable,
  teams as teamsTable,
  users as usersTable,
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
import {
  seedApp,
  seedServer,
  TRUNCATE_PROJECT_GRAPH,
} from "./app-graph-test-helpers";
import { deleteUser, getDeleteUserImpact } from "./user-delete";

/**
 * Permanently deleting a user account, against pglite.
 *
 * The teardown fan-out is harmless here: the seeded server has no agent record,
 * so `connectAgent` throws `AgentUnreachableError` before any socket is opened
 * and the detached teardown just warns — no gRPC, no network, no open handle.
 */

const USER_2 = "user_2";
const USER_3 = "user_3";
const T0 = "2026-01-01T00:00:00.000Z";

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
  await pg.exec(TRUNCATE_PROJECT_GRAPH);
  await pg.exec(TRUNCATE_IDENTITY);
});

/** Add an existing user to another team (seedIdentity seeds one membership each). */
async function addMembership(userId: string, teamId: string, role = "member") {
  const membershipId = `mem_${userId}_${teamId}`;
  await db.insert(membershipsTable).values({
    id: membershipId,
    userId,
    teamId,
    role,
    createdAt: T0,
  });
  await db.insert(membershipCapabilitiesTable).values(
    capabilitiesForRole(role as "owner" | "member" | "viewer").map((c) => ({
      membershipId,
      capability: c,
    })),
  );
}

async function seedFolder(id: string, teamId: string, ownerUserId: string) {
  await db.insert(foldersTable).values({
    id,
    teamId,
    name: id,
    ownerUserId,
    createdAt: T0,
    updatedAt: T0,
  });
}

async function exists(
  table: typeof teamsTable | typeof usersTable | typeof appsTable,
  id: string,
): Promise<boolean> {
  const rows = await db.select({ id: table.id }).from(table).where(eq(table.id, id));
  return rows.length > 0;
}

/** An admin (USER_1) plus the target (USER_2) who owns TEAM_B alone. */
async function seedAdminAndTarget() {
  await seedIdentity(db, {
    teams: [
      { id: TEAM_A, slug: "alpha" },
      { id: TEAM_B, slug: "beta", founderUserId: USER_2 },
    ],
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      { id: USER_2, teamId: TEAM_B, role: "owner", isInstanceAdmin: false },
    ],
  });
}

const ALL_OFF = {
  deleteCreatedApps: false,
  deleteOwnedWorkspaces: false,
  deleteFoundedTeams: false,
};

/* ------------------------------------------------------------------ */
/* Solo teams: always, and disclosed                                   */
/* ------------------------------------------------------------------ */

test("a team the user is alone in is deleted with the account, apps and all", async () => {
  await seedAdminAndTarget();
  await seedServer(db);
  await seedApp(db, { id: "prj_solo", teamId: TEAM_B, createdByUserId: USER_2 });

  const impact = await runWithIdentity({ userId: USER_1, teamId: TEAM_A }, () =>
    getDeleteUserImpact(USER_2),
  );
  assert.equal(impact.soloTeams.length, 1);
  assert.equal(impact.soloTeams[0]!.appCount, 1);
  assert.equal(impact.soloTeams[0]!.otherMemberCount, 0);
  // Already accounted for by the team line — never double-counted as an opt-in.
  assert.equal(impact.createdAppCount, 0);

  const res = await runWithIdentity({ userId: USER_1, teamId: TEAM_A }, () =>
    deleteUser(USER_2, ALL_OFF),
  );

  assert.equal(res.teamsDeleted, 1);
  assert.equal(res.appsDeleted, 1);
  assert.equal(await exists(usersTable, USER_2), false);
  assert.equal(await exists(teamsTable, TEAM_B), false);
  assert.equal(await exists(appsTable, "prj_solo"), false);
});

test("a shared team survives; the account just loses its membership", async () => {
  await seedAdminAndTarget();
  await addMembership(USER_1, TEAM_B, "member");

  const impact = await runWithIdentity({ userId: USER_1, teamId: TEAM_A }, () =>
    getDeleteUserImpact(USER_2),
  );
  assert.equal(impact.soloTeams.length, 0);
  // USER_2 founded TEAM_B and it still has USER_1 in it.
  assert.deepEqual(
    impact.foundedTeams.map((t) => t.teamId),
    [TEAM_B],
  );
  assert.equal(impact.foundedTeams[0]!.otherMemberCount, 1);

  await runWithIdentity({ userId: USER_1, teamId: TEAM_A }, () =>
    deleteUser(USER_2, ALL_OFF),
  );

  assert.equal(await exists(teamsTable, TEAM_B), true);
  const left = await db
    .select()
    .from(membershipsTable)
    .where(eq(membershipsTable.teamId, TEAM_B));
  assert.equal(left.length, 1);
  // The crown is vacated, never dangled.
  const team = (
    await db
      .select({ founderUserId: teamsTable.founderUserId })
      .from(teamsTable)
      .where(eq(teamsTable.id, TEAM_B))
  )[0]!;
  assert.equal(team.founderUserId, null);
});

test("deleteFoundedTeams takes the shared team too", async () => {
  await seedAdminAndTarget();
  await addMembership(USER_1, TEAM_B, "member");

  await runWithIdentity({ userId: USER_1, teamId: TEAM_A }, () =>
    deleteUser(USER_2, { ...ALL_OFF, deleteFoundedTeams: true }),
  );

  assert.equal(await exists(teamsTable, TEAM_B), false);
});

/* ------------------------------------------------------------------ */
/* The opt-ins                                                         */
/* ------------------------------------------------------------------ */

test("apps they created in a surviving team are kept unless asked for", async () => {
  await seedAdminAndTarget();
  await addMembership(USER_2, TEAM_A, "member");
  await seedServer(db);
  await seedApp(db, { id: "prj_theirs", teamId: TEAM_A, createdByUserId: USER_2 });
  await seedApp(db, { id: "prj_mine", teamId: TEAM_A, createdByUserId: USER_1 });
  // TEAM_B is USER_2's solo team and would be deleted regardless — drop it so
  // this case is only about the shared team.
  await db.delete(teamsTable).where(eq(teamsTable.id, TEAM_B));

  const impact = await runWithIdentity({ userId: USER_1, teamId: TEAM_A }, () =>
    getDeleteUserImpact(USER_2),
  );
  assert.equal(impact.createdAppCount, 1);

  await runWithIdentity({ userId: USER_1, teamId: TEAM_A }, () =>
    deleteUser(USER_2, ALL_OFF),
  );
  assert.equal(await exists(appsTable, "prj_theirs"), true);
  // Kept, but no longer attributed — the FK is SET NULL, never CASCADE.
  const row = (
    await db
      .select({ createdByUserId: appsTable.createdByUserId })
      .from(appsTable)
      .where(eq(appsTable.id, "prj_theirs"))
  )[0]!;
  assert.equal(row.createdByUserId, null);
});

test("deleteCreatedApps removes their apps and only theirs", async () => {
  await seedAdminAndTarget();
  await addMembership(USER_2, TEAM_A, "member");
  await seedServer(db);
  await seedApp(db, { id: "prj_theirs", teamId: TEAM_A, createdByUserId: USER_2 });
  await seedApp(db, { id: "prj_mine", teamId: TEAM_A, createdByUserId: USER_1 });
  await db.delete(teamsTable).where(eq(teamsTable.id, TEAM_B));

  const res = await runWithIdentity({ userId: USER_1, teamId: TEAM_A }, () =>
    deleteUser(USER_2, { ...ALL_OFF, deleteCreatedApps: true }),
  );

  assert.equal(res.appsDeleted, 1);
  assert.equal(await exists(appsTable, "prj_theirs"), false);
  assert.equal(await exists(appsTable, "prj_mine"), true);
});

test("deleteOwnedWorkspaces takes the folder and the apps inside it", async () => {
  await seedAdminAndTarget();
  await addMembership(USER_2, TEAM_A, "member");
  await seedServer(db);
  await seedFolder("fld_theirs", TEAM_A, USER_2);
  // Created by someone ELSE but parked in their folder: the folder is the claim.
  await seedApp(db, {
    id: "prj_in_folder",
    teamId: TEAM_A,
    folderId: "fld_theirs",
    createdByUserId: USER_1,
  });
  await db.delete(teamsTable).where(eq(teamsTable.id, TEAM_B));

  const impact = await runWithIdentity({ userId: USER_1, teamId: TEAM_A }, () =>
    getDeleteUserImpact(USER_2),
  );
  assert.equal(impact.ownedFolderCount, 1);
  assert.equal(impact.ownedAppCount, 1);

  await runWithIdentity({ userId: USER_1, teamId: TEAM_A }, () =>
    deleteUser(USER_2, { ...ALL_OFF, deleteOwnedWorkspaces: true }),
  );
  assert.equal(await exists(appsTable, "prj_in_folder"), false);
  const folders = await db
    .select()
    .from(foldersTable)
    .where(eq(foldersTable.id, "fld_theirs"));
  assert.equal(folders.length, 0);
});

test("an unclaimed folder is kept and simply loses its owner", async () => {
  await seedAdminAndTarget();
  await addMembership(USER_2, TEAM_A, "member");
  await seedFolder("fld_theirs", TEAM_A, USER_2);
  await db.delete(teamsTable).where(eq(teamsTable.id, TEAM_B));

  await runWithIdentity({ userId: USER_1, teamId: TEAM_A }, () =>
    deleteUser(USER_2, ALL_OFF),
  );

  const folder = (
    await db
      .select({ ownerUserId: foldersTable.ownerUserId })
      .from(foldersTable)
      .where(eq(foldersTable.id, "fld_theirs"))
  )[0]!;
  assert.equal(folder.ownerUserId, null);
});

/* ------------------------------------------------------------------ */
/* Guards                                                              */
/* ------------------------------------------------------------------ */

test("an admin can't delete their own account", async () => {
  await seedAdminAndTarget();

  await assert.rejects(
    runWithIdentity({ userId: USER_1, teamId: TEAM_A }, () =>
      deleteUser(USER_1, ALL_OFF),
    ),
    /can't delete your own account/,
  );
  assert.equal(await exists(usersTable, USER_1), true);
});

test("the instance owner's account is off limits", async () => {
  await seedIdentity(db, {
    teams: [
      { id: TEAM_A, slug: "alpha" },
      { id: TEAM_B, slug: "beta", founderUserId: USER_2 },
    ],
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      { id: USER_2, teamId: TEAM_B, role: "owner" },
    ],
  });
  await db
    .insert(instanceSettings)
    .values({ id: "default", ownerUserId: USER_2, updatedAt: T0 });

  const impact = await runWithIdentity({ userId: USER_1, teamId: TEAM_A }, () =>
    getDeleteUserImpact(USER_2),
  );
  assert.match(impact.blockedReason ?? "", /Transfer ownership first/);

  await assert.rejects(
    runWithIdentity({ userId: USER_1, teamId: TEAM_A }, () =>
      deleteUser(USER_2, ALL_OFF),
    ),
    /Transfer ownership first/,
  );
  assert.equal(await exists(usersTable, USER_2), true);
});

test("deleting a fellow admin is fine — the caller is the surviving admin", async () => {
  // The lockout invariant `updateUserAdmin` has to defend holds for free here:
  // the caller is an active instance admin (a suspended account can't even
  // authenticate) and can't delete themselves, so one always remains.
  await seedIdentity(db, {
    teams: [
      { id: TEAM_A, slug: "alpha" },
      { id: TEAM_B, slug: "beta", founderUserId: USER_2 },
    ],
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      { id: USER_2, teamId: TEAM_B, role: "owner" },
    ],
  });

  await runWithIdentity({ userId: USER_1, teamId: TEAM_A }, () =>
    deleteUser(USER_2, ALL_OFF),
  );

  const admins = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(eq(usersTable.isInstanceAdmin, true));
  assert.deepEqual(
    admins.map((a) => a.id),
    [USER_1],
  );
});

test("a non-admin can't delete anyone", async () => {
  await seedIdentity(db, {
    teams: [{ id: TEAM_A, slug: "alpha" }],
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      { id: USER_2, teamId: TEAM_A, role: "member", isInstanceAdmin: false },
      { id: USER_3, teamId: TEAM_A, role: "member", isInstanceAdmin: false },
    ],
  });

  await assert.rejects(
    runWithIdentity({ userId: USER_2, teamId: TEAM_A }, () =>
      deleteUser(USER_3, ALL_OFF),
    ),
    /Only an instance admin/,
  );
  await assert.rejects(
    runWithIdentity({ userId: USER_2, teamId: TEAM_A }, () =>
      getDeleteUserImpact(USER_3),
    ),
    /Only an instance admin/,
  );
});

/* ------------------------------------------------------------------ */
/* Nobody is left locked out of a surviving team                       */
/* ------------------------------------------------------------------ */

test("a team left with no member manager is healed, and says so first", async () => {
  await seedIdentity(db, {
    teams: [
      { id: TEAM_A, slug: "alpha" },
      { id: TEAM_B, slug: "beta", founderUserId: USER_2 },
    ],
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      { id: USER_2, teamId: TEAM_B, role: "owner", isInstanceAdmin: false },
      // A viewer holds neither manage_members nor manage_team, so deleting the
      // owner would strand TEAM_B unmanageable.
      { id: USER_3, teamId: TEAM_B, role: "viewer", isInstanceAdmin: false },
    ],
  });

  const impact = await runWithIdentity({ userId: USER_1, teamId: TEAM_A }, () =>
    getDeleteUserImpact(USER_2),
  );
  assert.deepEqual(impact.vacatedTeams, ["beta"]);

  await runWithIdentity({ userId: USER_1, teamId: TEAM_A }, () =>
    deleteUser(USER_2, ALL_OFF),
  );

  const caps = await db
    .select({ capability: membershipCapabilitiesTable.capability })
    .from(membershipCapabilitiesTable)
    .innerJoin(
      membershipsTable,
      eq(membershipsTable.id, membershipCapabilitiesTable.membershipId),
    )
    .where(eq(membershipsTable.teamId, TEAM_B));
  const held = caps.map((c) => c.capability);
  assert.ok(held.includes("manage_members"), "the survivor can manage members");
  assert.ok(held.includes("manage_team"), "the survivor can manage the team");
});
