import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import {
  activities as activitiesTable,
  folderGrants as folderGrantsTable,
  folders as foldersTable,
  instanceSettings,
  memberships as membershipsTable,
} from "../db/schema/control-plane";
import { runWithIdentity } from "../auth/request-context";
import { seedIdentity, TEAM_A, TEAM_B } from "./identity-test-helpers";
import { seedApp, seedServer } from "./app-graph-test-helpers";
import { listRoles } from "./roles";
import { updateMember } from "./members";
import {
  addUserToTeam,
  listUserAccess,
  listUserActivity,
  removeUserFromTeam,
  setMemberAccess,
  setUserTeamAccess,
} from "./user-access";

/**
 * The instance-admin write path for one person's access (ADR-0016).
 */

let db: TestDb;
let pg: PGlite;

const T0 = "2026-01-01T00:00:00.000Z";
const ADMIN = "u_admin"; // instance admin, member of TEAM_B only
const FOUNDER = "u_founder"; // founder + owner of TEAM_A
const DEV = "u_dev"; // plain member of TEAM_A
const FLD = "fld_prod";
const FLD_OTHER = "fld_other_team";
const APP = "prj_in_prod";

const as = <T>(
  userId: string,
  fn: () => Promise<T>,
  teamId = TEAM_B,
): Promise<T> => runWithIdentity({ userId, teamId }, fn);

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
});

after(async () => {
  __resetTestDb();
  await pg.close();
});

/** The roles of TEAM_A, read as the founder (who is in it). Roles are per-team. */
async function rolesOfTeamA() {
  return as(FOUNDER, () => listRoles(), TEAM_A);
}

/** The roles of TEAM_B, read as the admin (who is in it). */
async function rolesOfTeamB() {
  return as(ADMIN, () => listRoles(), TEAM_B);
}

beforeEach(async () => {
  await pg.exec(`truncate table
    activities, app_grants, folder_grants, project_grants,
    app_build_method_settings, app_build, apps, folders, projects, servers,
    team_role_capabilities, team_roles,
    membership_capabilities, memberships, users, teams, instance_settings
    restart identity cascade;`);
  await seedIdentity(db, {
    teams: [
      { id: TEAM_A, slug: "team-a", founderUserId: FOUNDER },
      { id: TEAM_B, slug: "team-b" },
    ],
    users: [
      { id: FOUNDER, teamId: TEAM_A, role: "owner", isInstanceAdmin: false },
      {
        id: DEV,
        teamId: TEAM_A,
        role: "member",
        isInstanceAdmin: false,
        capabilities: ["view", "deploy_apps"],
      },
      // The acting admin belongs to a DIFFERENT team - the whole reason this
      // surface exists.
      { id: ADMIN, teamId: TEAM_B, role: "owner", isInstanceAdmin: true },
    ],
  });
  await seedServer(db);
  await db.insert(foldersTable).values([
    {
      id: FLD,
      teamId: TEAM_A,
      name: "Prod",
      parentId: null,
      color: null,
      ownerUserId: FOUNDER,
      projectId: null,
      createdAt: T0,
      updatedAt: T0,
    },
    {
      id: FLD_OTHER,
      teamId: TEAM_B,
      name: "Somewhere else",
      parentId: null,
      color: null,
      ownerUserId: ADMIN,
      projectId: null,
      createdAt: T0,
      updatedAt: T0,
    },
  ]);
  await seedApp(db, { id: APP, teamId: TEAM_A, folderId: FLD });
});

/* ------------------------------------------------------------------ */

test("an admin sets a role in a team they don't belong to", async () => {
  const roles = await rolesOfTeamA();
  const viewer = roles.find((r) => r.builtinKey === "viewer")!;

  const after = await as(ADMIN, () =>
    setUserTeamAccess({
      userId: DEV,
      teamId: TEAM_A,
      roleId: viewer.id,
      granular: false,
    }),
  );
  const teamA = after.find((a) => a.teamId === TEAM_A)!;
  assert.equal(teamA.roleId, viewer.id);
  assert.equal(teamA.granular, false);
  assert.ok(!teamA.baseCapabilities.includes("deploy_apps"));
});

test("granular mode keeps the role as the base and writes the node rows", async () => {
  const roles = await rolesOfTeamA();
  const viewer = roles.find((r) => r.builtinKey === "viewer")!;

  const after = await as(ADMIN, () =>
    setUserTeamAccess({
      userId: DEV,
      teamId: TEAM_A,
      roleId: viewer.id,
      granular: true,
      grants: [
        { folderIds: [FLD], appIds: [APP], capabilities: ["manage_env"] },
      ],
    }),
  );
  const teamA = after.find((a) => a.teamId === TEAM_A)!;
  assert.equal(teamA.granular, true);
  assert.equal(teamA.roleId, viewer.id, "the role still supplies the base");
  assert.deepEqual(teamA.nodes.map((n) => `${n.kind}:${n.nodeId}`).sort(), [
    `app:${APP}`,
    `folder:${FLD}`,
  ]);
  assert.ok(teamA.nodes[0].capabilities.includes("manage_env"));

  // Switching back to Role mode clears every node row, no silent leftovers.
  const back = await as(ADMIN, () =>
    setUserTeamAccess({
      userId: DEV,
      teamId: TEAM_A,
      roleId: viewer.id,
      granular: false,
    }),
  );
  assert.deepEqual(back.find((a) => a.teamId === TEAM_A)!.nodes, []);
  assert.equal(
    (await db.select().from(folderGrantsTable)).length,
    0,
    "the grant rows are gone, not just hidden",
  );
});

test("the mode survives losing the last granted node", async () => {
  const roles = await rolesOfTeamA();
  const viewer = roles.find((r) => r.builtinKey === "viewer")!;
  await as(ADMIN, () =>
    setUserTeamAccess({
      userId: DEV,
      teamId: TEAM_A,
      roleId: viewer.id,
      granular: true,
      grants: [{ folderIds: [FLD], capabilities: ["manage_env"] }],
    }),
  );
  // The folder is deleted; its grant cascades away with it.
  await db.delete(foldersTable).where(eq(foldersTable.id, FLD));
  const after = await as(ADMIN, () => listUserAccess(DEV));
  const teamA = after.find((a) => a.teamId === TEAM_A)!;
  assert.equal(teamA.granular, true, "still granular, with nothing ticked");
  assert.deepEqual(teamA.nodes, []);
});

test("a node from another team is refused", async () => {
  const roles = await rolesOfTeamA();
  const viewer = roles.find((r) => r.builtinKey === "viewer")!;
  await assert.rejects(
    () =>
      as(ADMIN, () =>
        setUserTeamAccess({
          userId: DEV,
          teamId: TEAM_A,
          roleId: viewer.id,
          granular: true,
          // The folder belongs to TEAM_B - ticking it here would be a grant
          // reaching across a team boundary.
          grants: [{ folderIds: [FLD_OTHER], capabilities: ["manage_env"] }],
        }),
      ),
    /isn't in this team/i,
  );
});

test("a team-wide capability can't be handed out on a node", async () => {
  const roles = await rolesOfTeamA();
  const viewer = roles.find((r) => r.builtinKey === "viewer")!;
  await assert.rejects(
    () =>
      as(ADMIN, () =>
        setUserTeamAccess({
          userId: DEV,
          teamId: TEAM_A,
          roleId: viewer.id,
          granular: true,
          grants: [{ folderIds: [FLD], capabilities: ["manage_members"] }],
        }),
      ),
    /whole team/i,
  );
});

test("the founder's crown is closed to an instance admin", async () => {
  const roles = await rolesOfTeamA();
  const viewer = roles.find((r) => r.builtinKey === "viewer")!;
  await assert.rejects(
    () =>
      as(ADMIN, () =>
        setUserTeamAccess({
          userId: FOUNDER,
          teamId: TEAM_A,
          roleId: viewer.id,
          granular: false,
        }),
      ),
    /primary owner/i,
  );
  await assert.rejects(
    () =>
      as(ADMIN, () => removeUserFromTeam({ userId: FOUNDER, teamId: TEAM_A })),
    /primary owner/i,
  );
});

test("the instance owner's row is closed to every other admin", async () => {
  await db.insert(instanceSettings).values({
    id: "default",
    ownerUserId: DEV,
    updatedAt: T0,
  });
  const roles = await rolesOfTeamA();
  const viewer = roles.find((r) => r.builtinKey === "viewer")!;
  await assert.rejects(
    () =>
      as(ADMIN, () =>
        setUserTeamAccess({
          userId: DEV,
          teamId: TEAM_A,
          roleId: viewer.id,
          granular: false,
        }),
      ),
    /owns the instance/i,
  );
});

test("only an instance admin may use this surface", async () => {
  const roles = await rolesOfTeamA();
  const viewer = roles.find((r) => r.builtinKey === "viewer")!;
  await assert.rejects(
    () =>
      as(
        FOUNDER,
        () =>
          setUserTeamAccess({
            userId: DEV,
            teamId: TEAM_A,
            roleId: viewer.id,
            granular: false,
          }),
        TEAM_A,
      ),
    /instance admin/i,
    "owning the team is not enough - this is instance administration",
  );
});

test("add and remove a team, and removal takes the node grants with it", async () => {
  const member = (await rolesOfTeamA()).find((r) => r.builtinKey === "member")!;
  const memberB = (await rolesOfTeamB()).find(
    (r) => r.builtinKey === "member",
  )!;

  // DEV joins TEAM_B, gets a grant in TEAM_A, then leaves TEAM_A.
  const added = await as(ADMIN, () =>
    addUserToTeam({ userId: DEV, teamId: TEAM_B, roleId: memberB.id }),
  );
  assert.deepEqual(added.map((a) => a.teamId).sort(), [TEAM_A, TEAM_B].sort());
  await as(ADMIN, () =>
    setUserTeamAccess({
      userId: DEV,
      teamId: TEAM_A,
      roleId: member.id,
      granular: true,
      grants: [{ folderIds: [FLD], capabilities: ["manage_env"] }],
    }),
  );
  const after = await as(ADMIN, () =>
    removeUserFromTeam({ userId: DEV, teamId: TEAM_A }),
  );
  assert.deepEqual(
    after.map((a) => a.teamId),
    [TEAM_B],
  );
  assert.equal(
    (await db.select().from(folderGrantsTable)).length,
    0,
    "removal is what revokes every node grant at once",
  );
  assert.equal(
    (
      await db
        .select()
        .from(membershipsTable)
        .where(eq(membershipsTable.userId, DEV))
    ).length,
    1,
  );
});

test("the change lands in the affected team's Activity", async () => {
  const roles = await rolesOfTeamA();
  const viewer = roles.find((r) => r.builtinKey === "viewer")!;
  await as(ADMIN, () =>
    setUserTeamAccess({
      userId: DEV,
      teamId: TEAM_A,
      roleId: viewer.id,
      granular: false,
    }),
  );
  const rows = await db
    .select()
    .from(activitiesTable)
    .where(eq(activitiesTable.teamId, TEAM_A));
  assert.equal(
    rows.length,
    1,
    "logged in the team it affected, not the actor's",
  );
  assert.match(rows[0].message, /u_dev/);
  // And it is readable back on the target's own page.
  const feed = await as(ADMIN, () => listUserActivity(ADMIN, 10));
  assert.equal(feed.length, 1);
  assert.equal(feed[0].teamName, "team-a");
});

test("the team's OWN door logs it too, in the team it happened in", async () => {
  // Settings → Users is one door into a membership; the team's Members tab is the
  // other, and it used to write nothing at all - no Activity row, no alert.
  const roles = await rolesOfTeamA();
  const viewer = roles.find((r) => r.builtinKey === "viewer")!;
  await as(
    FOUNDER,
    () => updateMember({ userId: DEV, roleId: viewer.id }),
    TEAM_A,
  );
  const rows = await db
    .select()
    .from(activitiesTable)
    .where(eq(activitiesTable.teamId, TEAM_A));
  assert.equal(rows.length, 1);
  assert.match(rows[0].message, /u_dev/);
  assert.match(rows[0].message, /Viewer role/);
});

/* ------------------------------------------------------------------ */
/* The four guards that make the team-side door safe                   */
/* ------------------------------------------------------------------ */

test("nobody edits their own access, instance admin included", async () => {
  const roles = await rolesOfTeamB();
  const owner = roles.find((r) => r.builtinKey === "owner")!;
  await assert.rejects(
    () =>
      as(ADMIN, () =>
        setUserTeamAccess({
          userId: ADMIN,
          teamId: TEAM_B,
          roleId: owner.id,
          granular: false,
        }),
      ),
    /your own access/i,
    "an actor who can widen themselves has no boundary",
  );
});

test("the team-side door takes its team from the actor, never from the input", async () => {
  const rolesA = await rolesOfTeamA();
  const viewer = rolesA.find((r) => r.builtinKey === "viewer")!;

  // The founder administers TEAM_A, where they hold manage_members.
  const after = await as(
    FOUNDER,
    () => setMemberAccess({ userId: DEV, roleId: viewer.id, granular: false }),
    TEAM_A,
  );
  assert.deepEqual(
    after.map((a) => a.teamId),
    [TEAM_A],
    "and answers for that team alone",
  );
  assert.equal(after[0].roleName, viewer.name);

  // There is no id to pass: acting in TEAM_B, the same call can only ever write
  // TEAM_B, so a role of TEAM_A is simply not one of its roles.
  await assert.rejects(
    () =>
      as(
        ADMIN,
        () =>
          setMemberAccess({ userId: DEV, roleId: viewer.id, granular: false }),
        TEAM_B,
      ),
    /not found|permission|not in this team/i,
  );
});

test("an admin can't hand out what they don't hold on the node themselves", async () => {
  const roles = await rolesOfTeamA();
  const viewer = roles.find((r) => r.builtinKey === "viewer")!;

  // A second member of TEAM_A who may manage members but owns no folder and
  // holds no grant on FLD, which the founder owns.
  await db.insert((await import("../db/schema/control-plane")).users).values({
    id: "u_hr",
    email: "hr@example.io",
    username: "u_hr",
    name: "u_hr",
    role: "member",
    isInstanceAdmin: false,
    avatarColor: "#abc",
    createdAt: T0,
    updatedAt: T0,
  });
  await db.insert(membershipsTable).values({
    id: "mem_hr",
    userId: "u_hr",
    teamId: TEAM_A,
    role: "member",
    createdAt: T0,
  });
  await db
    .insert((await import("../db/schema/control-plane")).membershipCapabilities)
    .values(
      // Everything the Viewer role grants, so the ACTOR bound on the role
      // itself passes and the node bound below is what refuses. A caller can
      // only assign a role whose permissions they hold themselves.
      [
        "view",
        "view_logs",
        "view_metrics",
        "view_activity",
        "manage_members",
      ].map((capability) => ({ membershipId: "mem_hr", capability })),
    );

  // `manage_members` is the one capability this door asks for, and on its own it
  // must not become a way to deal out someone else's private folder.
  await assert.rejects(
    () =>
      as(
        "u_hr",
        () =>
          setMemberAccess({
            userId: DEV,
            roleId: viewer.id,
            granular: true,
            grants: [{ folderIds: [FLD], capabilities: ["manage_env"] }],
          }),
        TEAM_A,
      ),
    /isn't in this team any more/,
    "a folder they cannot see must answer as one that isn't there",
  );

  // The founder owns it, so for them the same call goes through.
  await as(
    FOUNDER,
    () =>
      setMemberAccess({
        userId: DEV,
        roleId: viewer.id,
        granular: true,
        grants: [{ folderIds: [FLD], capabilities: ["manage_env"] }],
      }),
    TEAM_A,
  );
  const grants = await db
    .select()
    .from(folderGrantsTable)
    .where(eq(folderGrantsTable.userId, DEV));
  assert.deepEqual(
    grants.map((g) => g.capability),
    ["manage_env"],
  );
});

test("manage_members alone cannot mint an owner, nor edit one", async () => {
  const roles = await rolesOfTeamA();
  const owner = roles.find((r) => r.builtinKey === "owner")!;
  const viewer = roles.find((r) => r.builtinKey === "viewer")!;

  // A member manager who is not an owner. They hold everything the Viewer role
  // grants, so only the RANK is in question here.
  await db.insert((await import("../db/schema/control-plane")).users).values({
    id: "u_hr2",
    email: "hr2@example.io",
    username: "u_hr2",
    name: "u_hr2",
    role: "member",
    isInstanceAdmin: false,
    avatarColor: "#abc",
    createdAt: T0,
    updatedAt: T0,
  });
  await db.insert(membershipsTable).values({
    id: "mem_hr2",
    userId: "u_hr2",
    teamId: TEAM_A,
    role: "member",
    createdAt: T0,
  });
  await db
    .insert((await import("../db/schema/control-plane")).membershipCapabilities)
    .values(
      [
        "view",
        "view_logs",
        "view_metrics",
        "view_activity",
        "manage_members",
      ].map((capability) => ({ membershipId: "mem_hr2", capability })),
    );

  // The Owner role grants everything, which is more than they hold - refused on
  // the capability bound before the rank one is even reached.
  await assert.rejects(
    () =>
      as(
        "u_hr2",
        () =>
          setMemberAccess({ userId: DEV, roleId: owner.id, granular: false }),
        TEAM_A,
      ),
    /you hold yourself|only an owner/i,
    "manage_members alone minted an owner",
  );

  // And an existing owner's access is an owner's to change.
  await db
    .update(membershipsTable)
    .set({ role: "owner" })
    .where(eq(membershipsTable.userId, DEV));
  await assert.rejects(
    () =>
      as(
        "u_hr2",
        () =>
          setMemberAccess({ userId: DEV, roleId: viewer.id, granular: false }),
        TEAM_A,
      ),
    /only an owner/i,
    "a non-owner demoted an owner",
  );
});
