// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import {
  membershipCapabilities as membershipCapabilitiesTable,
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
import { CAPABILITY_PRESETS } from "../membership-shared";
import { ALL_CAPABILITIES } from "../types";
import { listMembers, updateMember } from "./members";
import {
  createRole,
  deleteRole,
  listRoles,
  resetRole,
  updateRole,
} from "./roles";

/**
 * Team roles against pglite.
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
  assert.ok(
    roles.every((r) => !r.modified),
    "freshly seeded = unmodified",
  );

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

test("a hand-picked capability set is NOT adopted - it stays Custom", async () => {
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      // Neither the member nor the viewer preset: a genuine one-off set.
      {
        id: "odd",
        teamId: TEAM_A,
        role: "member",
        capabilities: ["view", "manage_backups"],
      },
    ],
  });
  const odd = (await asOwner(() => listMembers())).find(
    (m) => m.userId === "odd",
  )!;
  assert.equal(odd.roleId, null);
  assert.equal(odd.roleName, null);
  assert.deepEqual(odd.capabilities.slice().sort(), ["manage_backups", "view"]);
});

test("createRole: named, view is implied, duplicate names refused", async () => {
  await seedIdentity(db);
  const role = await asOwner(() =>
    createRole({
      name: "  Deployer  ",
      description: "Ships apps",
      capabilities: ["deploy_apps"],
    }),
  );
  assert.equal(role.name, "Deployer", "the name is trimmed");
  assert.deepEqual(
    role.capabilities,
    ["view", "deploy_apps"],
    "view is the floor",
  );
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
    createRole({ name: "Deployer", capabilities: ["deploy_apps"] }),
  );
  await asOwner(() => updateMember({ userId: "dev1", roleId: role.id }));
  await asOwner(() => updateMember({ userId: "dev2", roleId: role.id }));
  assert.deepEqual(await capsOf("dev1"), ["deploy_apps", "view"]);

  // Re-scoping the role reaches both members in the same write.
  await asOwner(() =>
    updateRole({
      id: role.id,
      name: "Deployer",
      capabilities: ["deploy_apps", "manage_domains"],
    }),
  );
  assert.deepEqual(await capsOf("dev1"), [
    "deploy_apps",
    "manage_domains",
    "view",
  ]);
  assert.deepEqual(await capsOf("dev2"), [
    "deploy_apps",
    "manage_domains",
    "view",
  ]);

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
    (await asOwner(() => listMembers())).find((m) => m.userId === "m1")!
      .roleName,
    "Member",
  );

  await assert.rejects(
    () =>
      asOwner(() =>
        updateRole({ id: owner.id, name: "Owner", capabilities: ["view"] }),
      ),
    /can't be edited/,
  );

  // Re-scope the Member default, then reset it - the member follows both ways.
  await asOwner(() =>
    updateRole({
      id: member.id,
      name: "Contributor",
      description: "Ours",
      capabilities: ["deploy_apps"],
    }),
  );
  assert.deepEqual(await capsOf("m1"), ["deploy_apps", "view"]);
  const edited = byName(await asOwner(() => listRoles()), "Contributor");
  assert.equal(edited.modified, true, "an edited default offers a reset");

  await asOwner(() => resetRole(member.id));
  const back = byName(await asOwner(() => listRoles()), "Member");
  assert.equal(back.modified, false);
  assert.deepEqual(
    await capsOf("m1"),
    [...CAPABILITY_PRESETS.member].sort(),
    "the member holding it is back on the shipped preset, permission for permission",
  );
  await assert.rejects(
    () =>
      asOwner(() => resetRole(edited.id === back.id ? "role_nope" : back.id)),
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
    createRole({ name: "Deployer", capabilities: ["deploy_apps"] }),
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
    (
      await db
        .select()
        .from(teamRolesTable)
        .where(eq(teamRolesTable.id, role.id))
    ).length,
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
  const foreign = await runWithIdentity(
    { userId: "b_owner", teamId: TEAM_B },
    () => createRole({ name: "Beta only", capabilities: ["deploy_apps"] }),
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
        capabilities: ["view", "deploy_apps", "manage_members", "manage_roles"],
      },
      { id: "m1", teamId: TEAM_A, role: "viewer", capabilities: ["view"] },
    ],
  });
  // Authoring: the manager may run backups on nothing - they don't hold it.
  await assert.rejects(
    () =>
      asUser("mgr", () =>
        createRole({ name: "Superuser", capabilities: ["manage_backups"] }),
      ),
    /only give a role permissions you hold yourself/,
  );
  // …but a role within their own set is fine.
  const ok = await asUser("mgr", () =>
    createRole({ name: "Shipper", capabilities: ["deploy_apps"] }),
  );
  assert.deepEqual(ok.capabilities, ["view", "deploy_apps"]);

  // Assigning: an owner-authored role that outranks them is refused outright,
  // rather than quietly assigned with fewer permissions than it says.
  const powerful = await asOwner(() =>
    createRole({ name: "Infra", capabilities: ["manage_backups"] }),
  );
  await assert.rejects(
    () =>
      asUser("mgr", () => updateMember({ userId: "m1", roleId: powerful.id })),
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
        capabilities: ["view", "manage_members", "manage_roles", "manage_team"],
      },
    ],
  });
  const admins = await asOwner(() =>
    createRole({
      name: "Admins",
      capabilities: ["manage_members", "manage_roles", "manage_team"],
    }),
  );
  await asOwner(() => updateMember({ userId: USER_1, roleId: admins.id }));
  assert.deepEqual(await capsOf(USER_1), [
    "manage_members",
    "manage_roles",
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
          capabilities: ["manage_roles", "manage_team"],
        }),
      ),
    /at least one member who can manage members/,
  );
  // The refusal rolled the whole edit back - role and member are untouched.
  assert.deepEqual(await capsOf(USER_1), [
    "manage_members",
    "manage_roles",
    "manage_team",
    "view",
  ]);
  assert.deepEqual(
    byName(await asOwner(() => listRoles()), "Admins")
      .capabilities.slice()
      .sort(),
    ["manage_members", "manage_roles", "manage_team", "view"],
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
    createRole({
      name: "Almost",
      capabilities: ["manage_members", "manage_team"],
    }),
  );
  await asOwner(() => updateMember({ userId: "m1", roleId: custom.id }));
  const [after] = await db
    .select({ role: membershipsTable.role })
    .from(membershipsTable)
    .where(eq(membershipsTable.userId, "m1"));
  assert.equal(after.role, "member");
});

/* ------------------------------------------------------------------ */
/* The audit's regressions on the role WRITE path.                     */
/* ------------------------------------------------------------------ */

test("an absent field on updateRole means leave it alone, not clear it", async () => {
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      { id: "u_dev", teamId: TEAM_A, role: "member", capabilities: ["view"] },
    ],
  });
  const role = await asOwner(() =>
    createRole({
      name: "Deployer",
      capabilities: ["view", "deploy_apps", "view_logs"],
      requireTwoFactor: true,
    }),
  );
  await asOwner(() => updateMember({ userId: "u_dev", roleId: role.id }));
  assert.deepEqual(await capsOf("u_dev"), ["deploy_apps", "view", "view_logs"]);

  // The rename an API client writes: `capabilities` and `requireTwoFactor` are
  // both optional in the SDL, and both used to be read as "" and false. A bare
  // rename stripped every holder to `view` and lifted the 2FA mandate.
  await asOwner(() => updateRole({ id: role.id, name: "Deployers" }));

  const after = byName(await asOwner(() => listRoles()), "Deployers");
  assert.deepEqual(
    after.capabilities.slice().sort(),
    ["deploy_apps", "view", "view_logs"],
    "a rename wiped the role's permissions",
  );
  assert.equal(after.requireTwoFactor, true, "a rename lifted the 2FA mandate");
  assert.deepEqual(
    await capsOf("u_dev"),
    ["deploy_apps", "view", "view_logs"],
    "a rename wiped every holder's permissions",
  );

  // Sending the field explicitly still replaces it, so this is not a refusal to
  // write - only a refusal to invent an empty value.
  await asOwner(() =>
    updateRole({ id: role.id, name: "Deployers", capabilities: ["view"] }),
  );
  assert.deepEqual(await capsOf("u_dev"), ["view"]);
});

test("a scope-only edit re-syncs the holders without touching the authored set", async () => {
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      { id: "u_dev", teamId: TEAM_A, role: "member", capabilities: ["view"] },
    ],
  });
  const { projects } = await import("../db/schema/control-plane");
  await db.insert(projects).values({
    id: "prc_x",
    teamId: TEAM_A,
    name: "X",
    slug: "x",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  const role = await asOwner(() =>
    createRole({
      name: "Ops",
      capabilities: ["view", "deploy_apps", "manage_members"],
    }),
  );
  await asOwner(() => updateMember({ userId: "u_dev", roleId: role.id }));
  assert.ok((await capsOf("u_dev")).includes("manage_members"));

  // Limiting the role, and NOTHING else - no capabilities in the payload. The
  // authored set must survive; the EFFECTIVE one must lose the team-wide verb.
  await asOwner(() =>
    updateRole({ id: role.id, name: "Ops", scope: { projectIds: ["prc_x"] } }),
  );
  const after = byName(await asOwner(() => listRoles()), "Ops");
  assert.deepEqual(after.capabilities.slice().sort(), [
    "deploy_apps",
    "manage_members",
    "view",
  ]);
  assert.deepEqual(
    await capsOf("u_dev"),
    ["deploy_apps", "view"],
    "the scope did not re-clamp the holders",
  );
});

test("a scoped role is never matched by the legacy rank+capabilities shape", async () => {
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      { id: "u_dev", teamId: TEAM_A, role: "member", capabilities: ["view"] },
    ],
  });
  const { projects } = await import("../db/schema/control-plane");
  await db.insert(projects).values({
    id: "prc_x",
    teamId: TEAM_A,
    name: "X",
    slug: "x",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  const scoped = await asOwner(() =>
    createRole({
      name: "Prod only",
      capabilities: ["view", "deploy_apps"],
      scope: { projectIds: ["prc_x"] },
    }),
  );

  // rank + capabilities says nothing about REACH, and matching compares the
  // CLAMPED set, which makes a limited role the likeliest match for a short
  // list. Landing on it handed the membership a boundary nobody asked for.
  await asOwner(() =>
    updateMember({
      userId: "u_dev",
      role: "member",
      capabilities: ["view", "deploy_apps"],
    }),
  );
  const m = (
    await db
      .select({ roleId: membershipsTable.roleId })
      .from(membershipsTable)
      .where(eq(membershipsTable.userId, "u_dev"))
  )[0];
  assert.notEqual(m.roleId, scoped.id, "a legacy edit landed on a SCOPED role");
  assert.deepEqual(await capsOf("u_dev"), ["deploy_apps", "view"]);
});

test("limiting a built-in marks it edited, so the way back stays offered", async () => {
  await seedIdentity(db, {
    users: [{ id: USER_1, teamId: TEAM_A, role: "owner" }],
  });
  const { projects } = await import("../db/schema/control-plane");
  await db.insert(projects).values({
    id: "prc_x",
    teamId: TEAM_A,
    name: "X",
    slug: "x",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  const member = byName(await asOwner(() => listRoles()), "Member");
  assert.equal(member.modified, false, "a freshly seeded default is pristine");

  // A re-scope leaves `team_role_capabilities` untouched, so comparing
  // capabilities alone read this as unchanged: no "Edited" badge in the rail,
  // and no "Reset to default" on the one role that most needs the way back.
  await asOwner(() =>
    updateRole({
      id: member.id,
      name: member.name,
      description: member.description,
      capabilities: member.capabilities,
      scope: { projectIds: ["prc_x"] },
    }),
  );
  assert.equal(
    byName(await asOwner(() => listRoles()), member.name).modified,
    true,
    "a built-in limited away from its default still reads as pristine",
  );
});

test("every capability that exists is reachable: the Owner role holds all of them", async () => {
  // A NEW capability is easy to ship half-dead: the enum, the gate and the UI all
  // land, while every capability row already in the database predates it, so nobody,
  // not even the founder, can use the feature.
  await seedIdentity(db);
  const owner = byName(await asOwner(() => listRoles()), "Owner");
  for (const cap of ALL_CAPABILITIES) {
    assert.ok(
      owner.capabilities.includes(cap),
      `the Owner role is missing "${cap}" - a capability nobody can hold is a feature nobody can reach`,
    );
  }

  // And the flat set the checks actually read must agree with the role.
  const rows = await db
    .select()
    .from(membershipCapabilitiesTable)
    .innerJoin(
      membershipsTable,
      eq(membershipCapabilitiesTable.membershipId, membershipsTable.id),
    )
    .where(eq(membershipsTable.userId, USER_1));
  const held = new Set(rows.map((r) => r.membership_capabilities.capability));
  for (const cap of ALL_CAPABILITIES) {
    assert.ok(held.has(cap), `the owner's membership is missing "${cap}"`);
  }
});
