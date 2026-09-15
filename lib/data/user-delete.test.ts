import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import {
  memberships as membershipsTable,
  membershipCapabilities as membershipCapabilitiesTable,
} from "../db/schema/control-plane/access-control";
import { apps as appsTable } from "../db/schema/control-plane/apps";
import {
  teams as teamsTable,
  users as usersTable,
} from "../db/schema/control-plane/identity";
import { instanceSettings } from "../db/schema/control-plane/instance";
import { folders as foldersTable } from "../db/schema/control-plane/projects";
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
  const rows = await db
    .select({ id: table.id })
    .from(table)
    .where(eq(table.id, id));
  return rows.length > 0;
}

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

test("a team the user is alone in is deleted with the account, apps and all", async () => {
  await seedAdminAndTarget();
  await seedServer(db);
  await seedApp(db, {
    id: "prj_solo",
    teamId: TEAM_B,
    createdByUserId: USER_2,
  });

  const impact = await runWithIdentity({ userId: USER_1, teamId: TEAM_A }, () =>
    getDeleteUserImpact(USER_2),
  );
  assert.equal(impact.soloTeams.length, 1);
  assert.equal(impact.soloTeams[0]!.appCount, 1);
  assert.equal(impact.soloTeams[0]!.otherMemberCount, 0);
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

test("apps they created in a surviving team are kept unless asked for", async () => {
  await seedAdminAndTarget();
  await addMembership(USER_2, TEAM_A, "member");
  await seedServer(db);
  await seedApp(db, {
    id: "prj_theirs",
    teamId: TEAM_A,
    createdByUserId: USER_2,
  });
  await seedApp(db, {
    id: "prj_mine",
    teamId: TEAM_A,
    createdByUserId: USER_1,
  });
  await db.delete(teamsTable).where(eq(teamsTable.id, TEAM_B));

  const impact = await runWithIdentity({ userId: USER_1, teamId: TEAM_A }, () =>
    getDeleteUserImpact(USER_2),
  );
  assert.equal(impact.createdAppCount, 1);

  await runWithIdentity({ userId: USER_1, teamId: TEAM_A }, () =>
    deleteUser(USER_2, ALL_OFF),
  );
  assert.equal(await exists(appsTable, "prj_theirs"), true);
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
  await seedApp(db, {
    id: "prj_theirs",
    teamId: TEAM_A,
    createdByUserId: USER_2,
  });
  await seedApp(db, {
    id: "prj_mine",
    teamId: TEAM_A,
    createdByUserId: USER_1,
  });
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

test("an unclaimed folder is kept, and passes to the team's primary owner", async () => {
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
  assert.equal(folder.ownerUserId, USER_1, "TEAM_A's founder takes it");
});

test("a folder in a team they founded and leave behind goes to the deleting admin", async () => {
  await seedAdminAndTarget();
  await addMembership(USER_1, TEAM_B, "member");
  await seedFolder("fld_founded", TEAM_B, USER_2);

  await runWithIdentity({ userId: USER_1, teamId: TEAM_A }, () =>
    deleteUser(USER_2, ALL_OFF),
  );

  assert.equal(await exists(teamsTable, TEAM_B), true);
  const folder = (
    await db
      .select({ ownerUserId: foldersTable.ownerUserId })
      .from(foldersTable)
      .where(eq(foldersTable.id, "fld_founded"))
  )[0]!;
  assert.equal(
    folder.ownerUserId,
    USER_1,
    "the crown left with the account, so the admin who deleted it holds the folder",
  );
});

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

test("deleting a fellow admin is fine - the caller is the surviving admin", async () => {
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

test("a team left with no member manager is healed, and says so first", async () => {
  await seedIdentity(db, {
    teams: [
      { id: TEAM_A, slug: "alpha" },
      { id: TEAM_B, slug: "beta", founderUserId: USER_2 },
    ],
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      { id: USER_2, teamId: TEAM_B, role: "owner", isInstanceAdmin: false },
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
  assert.ok(
    held.includes("manage_roles"),
    "and the roles - every write to a member re-asserts all three",
  );
});
