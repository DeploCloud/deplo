import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import {
  memberships as membershipsTable,
  teamRoles as teamRolesTable,
} from "../db/schema/control-plane";
import { runWithIdentity } from "../auth/request-context";
import {
  seedIdentity,
  TRUNCATE_IDENTITY,
  TEAM_A,
  TEAM_B,
  USER_1,
} from "./identity-test-helpers";
import { listMembers, updateMember } from "./members";
import {
  createRole,
  deleteRole,
  listRoles,
  resetRole,
  updateRole,
} from "./roles";

/**
 * Team roles against pglite. The invariant under test throughout is that a role
 * IS its members' capabilities: assigning one rewrites them, editing one rewrites
 * them for everyone holding it, and no path can leave the team with nobody able
 * to administer it.
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
  await pg.exec(TRUNCATE_IDENTITY);
});

const asOwner = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);

const asUser = <T>(userId: string, fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId, teamId: TEAM_A }, fn);

const byName = <T extends { name: string }>(roles: T[], name: string): T =>
  roles.find((r) => r.name === name)!;

const capsOf = async (userId: string): Promise<string[]> =>
  (await asOwner(() => listMembers()))
    .find((m) => m.userId === userId)!
    .capabilities.slice()
    .sort();

test("the three defaults are seeded on first read and the owner adopts theirs", async () => {
  await seedIdentity(db);
  const roles = await asOwner(() => listRoles());
  assert.deepEqual(
    roles.map((r) => r.builtinKey),
    ["owner", "member", "viewer"],
    "defaults come back in their canonical order",
  );
  assert.equal(byName(roles, "Owner").locked, true);
  assert.equal(byName(roles, "Owner").memberCount, 1);
  assert.equal(byName(roles, "Member").memberCount, 0);
  assert.ok(roles.every((r) => !r.modified), "freshly seeded = unmodified");

  // The founder's pre-roles membership adopted the Owner role, so the member
  // list names it instead of reading "Custom".
  const me = (await asOwner(() => listMembers())).find(
    (m) => m.userId === USER_1,
  )!;
  assert.equal(me.roleName, "Owner");
  assert.equal(me.roleId, byName(roles, "Owner").id);

  // Idempotent: a second read seeds nothing more.
  const again = await asOwner(() => listRoles());
  assert.equal(again.length, 3);
});

test("a hand-picked capability set is NOT adopted — it stays Custom", async () => {
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      // Neither the member nor the viewer preset: a genuine one-off set.
      { id: "odd", teamId: TEAM_A, role: "member", capabilities: ["view", "manage_infra"] },
    ],
  });
  const odd = (await asOwner(() => listMembers())).find((m) => m.userId === "odd")!;
  assert.equal(odd.roleId, null);
  assert.equal(odd.roleName, null);
  assert.deepEqual(odd.capabilities.slice().sort(), ["manage_infra", "view"]);
});

test("createRole: named, view is implied, duplicate names refused", async () => {
  await seedIdentity(db);
  const role = await asOwner(() =>
    createRole({
      name: "  Deployer  ",
      description: "Ships apps",
      capabilities: ["deploy"],
    }),
  );
  assert.equal(role.name, "Deployer", "the name is trimmed");
  assert.deepEqual(role.capabilities, ["view", "deploy"], "view is the floor");
  assert.equal(role.builtinKey, null);
  assert.equal(role.locked, false);

  await assert.rejects(
    () => asOwner(() => createRole({ name: "deployer", capabilities: [] })),
    /already has a role called/,
    "names collide case-insensitively",
  );
  await assert.rejects(
    () => asOwner(() => createRole({ name: "   ", capabilities: [] })),
    /Give the role a name/,
  );
});

test("editing a role rewrites the capabilities of everyone holding it", async () => {
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      { id: "dev1", teamId: TEAM_A, role: "viewer", capabilities: ["view"] },
      { id: "dev2", teamId: TEAM_A, role: "viewer", capabilities: ["view"] },
    ],
  });
  const role = await asOwner(() =>
    createRole({ name: "Deployer", capabilities: ["deploy"] }),
  );
  await asOwner(() => updateMember({ userId: "dev1", roleId: role.id }));
  await asOwner(() => updateMember({ userId: "dev2", roleId: role.id }));
  assert.deepEqual(await capsOf("dev1"), ["deploy", "view"]);

  // Re-scoping the role reaches both members in the same write.
  await asOwner(() =>
    updateRole({
      id: role.id,
      name: "Deployer",
      capabilities: ["deploy", "manage_domains"],
    }),
  );
  assert.deepEqual(await capsOf("dev1"), ["deploy", "manage_domains", "view"]);
  assert.deepEqual(await capsOf("dev2"), ["deploy", "manage_domains", "view"]);

  // …and taking a permission away reaches them too.
  await asOwner(() =>
    updateRole({ id: role.id, name: "Reader", capabilities: [] }),
  );
  assert.deepEqual(await capsOf("dev1"), ["view"]);
  const renamed = (await asOwner(() => listMembers())).find(
    (m) => m.userId === "dev1",
  )!;
  assert.equal(renamed.roleName, "Reader");
});

test("the Owner default is locked, and a default reverts to its preset", async () => {
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      { id: "m1", teamId: TEAM_A, role: "member" },
    ],
  });
  const roles = await asOwner(() => listRoles());
  const owner = byName(roles, "Owner");
  const member = byName(roles, "Member");
  assert.equal(
    (await asOwner(() => listMembers())).find((m) => m.userId === "m1")!.roleName,
    "Member",
  );

  await assert.rejects(
    () =>
      asOwner(() =>
        updateRole({ id: owner.id, name: "Owner", capabilities: ["view"] }),
      ),
    /can't be edited/,
  );

  // Re-scope the Member default, then reset it — the member follows both ways.
  await asOwner(() =>
    updateRole({
      id: member.id,
      name: "Contributor",
      description: "Ours",
      capabilities: ["deploy"],
    }),
  );
  assert.deepEqual(await capsOf("m1"), ["deploy", "view"]);
  const edited = byName(await asOwner(() => listRoles()), "Contributor");
  assert.equal(edited.modified, true, "an edited default offers a reset");

  await asOwner(() => resetRole(member.id));
  const back = byName(await asOwner(() => listRoles()), "Member");
  assert.equal(back.modified, false);
  assert.deepEqual(await capsOf("m1"), [
    "deploy",
    "manage_domains",
    "manage_env",
    "manage_files",
    "view",
  ]);
  await assert.rejects(
    () => asOwner(() => resetRole(edited.id === back.id ? "role_nope" : back.id)),
    /not found|Only a default role/,
  );
});

test("deleting a role: refused while held, refused for defaults, allowed when free", async () => {
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      { id: "m1", teamId: TEAM_A, role: "member" },
    ],
  });
  const role = await asOwner(() =>
    createRole({ name: "Deployer", capabilities: ["deploy"] }),
  );
  await asOwner(() => updateMember({ userId: "m1", roleId: role.id }));
  await assert.rejects(
    () => asOwner(() => deleteRole(role.id)),
    /1 member still has the Deployer role/,
  );

  const builtinMember = byName(await asOwner(() => listRoles()), "Member");
  await assert.rejects(
    () => asOwner(() => deleteRole(builtinMember.id)),
    /Default roles can't be deleted/,
  );

  // Move the member off it, then the delete goes through.
  await asOwner(() => updateMember({ userId: "m1", roleId: builtinMember.id }));
  await asOwner(() => deleteRole(role.id));
  const left = await asOwner(() => listRoles());
  assert.equal(left.length, 3);
  assert.equal(
    (await db.select().from(teamRolesTable).where(eq(teamRolesTable.id, role.id)))
      .length,
    0,
  );
});

test("a role from another team is not found (cross-team ids hit nothing)", async () => {
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      { id: "b_owner", teamId: TEAM_B, role: "owner" },
    ],
  });
  const foreign = await runWithIdentity({ userId: "b_owner", teamId: TEAM_B }, () =>
    createRole({ name: "Beta only", capabilities: ["deploy"] }),
  );
  await assert.rejects(
    () =>
      asOwner(() =>
        updateRole({ id: foreign.id, name: "Stolen", capabilities: [] }),
      ),
    /Role not found/,
  );
  await assert.rejects(
    () => asOwner(() => deleteRole(foreign.id)),
    /Role not found/,
  );
});

test("a non-owner can't author or assign a role above their own rank", async () => {
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      {
        id: "mgr",
        teamId: TEAM_A,
        role: "member",
        capabilities: ["view", "deploy", "manage_members"],
      },
      { id: "m1", teamId: TEAM_A, role: "viewer", capabilities: ["view"] },
    ],
  });
  // Authoring: the manager holds neither manage_infra nor manage_team.
  await assert.rejects(
    () =>
      asUser("mgr", () =>
        createRole({ name: "Superuser", capabilities: ["manage_infra"] }),
      ),
    /only give a role permissions you hold yourself/,
  );
  // …but a role within their own set is fine.
  const ok = await asUser("mgr", () =>
    createRole({ name: "Shipper", capabilities: ["deploy"] }),
  );
  assert.deepEqual(ok.capabilities, ["view", "deploy"]);

  // Assigning: an owner-authored role that outranks them is refused outright,
  // rather than quietly assigned with fewer permissions than it says.
  const powerful = await asOwner(() =>
    createRole({ name: "Infra", capabilities: ["manage_infra"] }),
  );
  await assert.rejects(
    () => asUser("mgr", () => updateMember({ userId: "m1", roleId: powerful.id })),
    /only assign a role whose permissions you hold yourself/,
  );
  assert.deepEqual(await capsOf("m1"), ["view"], "nothing changed");
});

test("a role edit can't strip the team of its last administrator", async () => {
  // No founder and no owner-role holder: the team's only administrator holds a
  // custom role, so re-scoping that role is what would lock everyone out.
  await seedIdentity(db, {
    teams: [{ id: TEAM_A, slug: "alpha", founderUserId: null }],
    users: [
      {
        id: USER_1,
        teamId: TEAM_A,
        role: "owner",
        capabilities: ["view", "manage_members", "manage_team"],
      },
    ],
  });
  const admins = await asOwner(() =>
    createRole({ name: "Admins", capabilities: ["manage_members", "manage_team"] }),
  );
  await asOwner(() => updateMember({ userId: USER_1, roleId: admins.id }));
  assert.deepEqual(await capsOf(USER_1), [
    "manage_members",
    "manage_team",
    "view",
  ]);

  // Dropping manage_members from the role drops it from its only holder.
  await assert.rejects(
    () =>
      asOwner(() =>
        updateRole({
          id: admins.id,
          name: "Admins",
          capabilities: ["manage_team"],
        }),
      ),
    /at least one member who can manage members/,
  );
  // The refusal rolled the whole edit back — role and member are untouched.
  assert.deepEqual(await capsOf(USER_1), [
    "manage_members",
    "manage_team",
    "view",
  ]);
  assert.deepEqual(
    byName(await asOwner(() => listRoles()), "Admins").capabilities.slice().sort(),
    ["manage_members", "manage_team", "view"],
  );
});

test("assigning a role stamps the rank the guards read", async () => {
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      { id: "m1", teamId: TEAM_A, role: "viewer", capabilities: ["view"] },
    ],
  });
  const roles = await asOwner(() => listRoles());
  await asOwner(() =>
    updateMember({ userId: "m1", roleId: byName(roles, "Owner").id }),
  );
  const [row] = await db
    .select({ role: membershipsTable.role, roleId: membershipsTable.roleId })
    .from(membershipsTable)
    .where(eq(membershipsTable.userId, "m1"));
  assert.equal(row.role, "owner", "the Owner role ranks as owner");
  assert.equal(row.roleId, byName(roles, "Owner").id);

  // A custom role ranks as a plain member, however much it grants.
  const custom = await asOwner(() =>
    createRole({ name: "Almost", capabilities: ["manage_members", "manage_team"] }),
  );
  await asOwner(() => updateMember({ userId: "m1", roleId: custom.id }));
  const [after] = await db
    .select({ role: membershipsTable.role })
    .from(membershipsTable)
    .where(eq(membershipsTable.userId, "m1"));
  assert.equal(after.role, "member");
});
