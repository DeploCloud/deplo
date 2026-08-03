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
import {
  addUserToTeam,
  listUserAccess,
  listUserActivity,
  removeUserFromTeam,
  setUserTeamAccess,
} from "./user-access";

/**
 * The instance-admin write path for one person's access (ADR-0016).
 *
 * The point of this surface is that an admin can answer "who can touch Prod?"
 * without being a member of the team in question — so the tests that matter are
 * the ones proving it does NOT become a way around the team's own rules: the
 * founder's crown, the instance owner's row, and the last member who can
 * administer the team.
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

const as = <T>(userId: string, fn: () => Promise<T>, teamId = TEAM_B): Promise<T> =>
  runWithIdentity({ userId, teamId }, fn);

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
      // The acting admin belongs to a DIFFERENT team — the whole reason this
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
      grants: [{ folderIds: [FLD], appIds: [APP], capabilities: ["manage_env"] }],
    }),
  );
  const teamA = after.find((a) => a.teamId === TEAM_A)!;
  assert.equal(teamA.granular, true);
  assert.equal(teamA.roleId, viewer.id, "the role still supplies the base");
  assert.deepEqual(
    teamA.nodes.map((n) => `${n.kind}:${n.nodeId}`).sort(),
    [`app:${APP}`, `folder:${FLD}`],
  );
  assert.ok(teamA.nodes[0].capabilities.includes("manage_env"));

  // Switching back to Role mode clears every node row — no silent leftovers.
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
          // The folder belongs to TEAM_B — ticking it here would be a grant
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
    () => as(ADMIN, () => removeUserFromTeam({ userId: FOUNDER, teamId: TEAM_A })),
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
    "owning the team is not enough — this is instance administration",
  );
});

test("add and remove a team, and removal takes the node grants with it", async () => {
  const member = (await rolesOfTeamA()).find((r) => r.builtinKey === "member")!;
  const memberB = (await rolesOfTeamB()).find((r) => r.builtinKey === "member")!;

  // DEV joins TEAM_B, gets a grant in TEAM_A, then leaves TEAM_A.
  const added = await as(ADMIN, () =>
    addUserToTeam({ userId: DEV, teamId: TEAM_B, roleId: memberB.id }),
  );
  assert.deepEqual(
    added.map((a) => a.teamId).sort(),
    [TEAM_A, TEAM_B].sort(),
  );
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
    (await db.select().from(membershipsTable).where(eq(membershipsTable.userId, DEV)))
      .length,
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
  assert.equal(rows.length, 1, "logged in the team it affected, not the actor's");
  assert.match(rows[0].message, /u_dev/);
  // And it is readable back on the target's own page.
  const feed = await as(ADMIN, () => listUserActivity(ADMIN, 10));
  assert.equal(feed.length, 1);
  assert.equal(feed[0].teamName, "team-a");
});
