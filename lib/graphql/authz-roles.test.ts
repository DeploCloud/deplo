import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { graphql } from "graphql";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { teamRoles as teamRolesTable } from "../db/schema/control-plane";
import { schema } from "./schema";
import type { GraphQLContext } from "./context";
import { runWithIdentity } from "../auth/request-context";
import { getCurrentUser } from "../auth";
import {
  getActiveTeamId,
  membershipFor,
  reachableCapabilities,
} from "../membership";
import { createRole, updateRole, deleteRole } from "../data/roles";
import { updateMember } from "../data/members";
import {
  seedIdentity,
  TRUNCATE_IDENTITY,
  TEAM_A,
  USER_1,
} from "../data/identity-test-helpers";
import { ALL_CAPABILITIES, type Capability } from "../types";

/**
 * Roles, end to end: a role is not a preset that a member's permissions drift
 * away from - it IS what they can do, so the only honest test of one is what the
 * API does after it is assigned and after it is edited.
 *
 * The capability→endpoint half lives in `authz-matrix.test.ts`; this file joins
 * it to the role machinery, for every capability in the catalogue: a role that
 * names exactly one permission must give its holder exactly that permission (and
 * the `view` floor), never the preset it was cloned from and never more.
 */

let db: TestDb;
let pg: PGlite;

const USER_M = "user_roled";

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
  await pg.exec(
    `truncate table team_roles, activities restart identity cascade;`,
  );
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      { id: USER_M, teamId: TEAM_A, role: "member", capabilities: ["view"] },
    ],
  });
});

const asOwner = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);

/** Effective capabilities the authorization layer will actually read. */
async function effectiveCaps(userId = USER_M): Promise<Capability[]> {
  return runWithIdentity({ userId, teamId: TEAM_A }, async () => {
    const m = await membershipFor(userId, TEAM_A);
    return m?.capabilities ?? [];
  });
}

async function callAs(userId: string, doc: string): Promise<string[]> {
  return runWithIdentity({ userId, teamId: TEAM_A }, async () => {
    const ctx: GraphQLContext = {
      viewer: await getCurrentUser(),
      teamId: await getActiveTeamId(),
      capabilities: await reachableCapabilities(),
      via: "cookie",
      identity: null,
    };
    const result = await graphql({ schema, source: doc, contextValue: ctx });
    return (result.errors ?? []).map((e) => e.message);
  });
}

const REFUSED = /not authorized|don't have permission/i;
const refused = (m: string[]): boolean => m.some((x) => REFUSED.test(x));

test("a role granting one permission grants exactly that one, for all forty", async () => {
  for (const cap of ALL_CAPABILITIES) {
    const role = await asOwner(() =>
      createRole({ name: `Only ${cap}`, capabilities: [cap] }),
    );
    await asOwner(() => updateMember({ userId: USER_M, roleId: role.id }));
    assert.deepEqual(
      await effectiveCaps(),
      cap === "view" ? ["view"] : ["view", cap],
      `the role for ${cap} did not resolve to exactly that permission`,
    );
  }
});

test("editing a role re-answers the API for everyone holding it, with nothing cached", async () => {
  const role = await asOwner(() =>
    createRole({ name: "Deployer", capabilities: ["deploy_apps"] }),
  );
  await asOwner(() => updateMember({ userId: USER_M, roleId: role.id }));
  const deploy = `mutation { redeploy(appId: "prj_nonexistent") { id } }`;
  assert.ok(
    !refused(await callAs(USER_M, deploy)),
    "the role's holder can deploy while the role says so",
  );

  await asOwner(() =>
    updateRole({ id: role.id, name: "Deployer", capabilities: ["view_logs"] }),
  );
  assert.ok(
    refused(await callAs(USER_M, deploy)),
    "dropping the permission from the role must refuse the very next call",
  );
  assert.deepEqual(await effectiveCaps(), ["view", "view_logs"]);
});

test("deleting a role is refused while somebody still holds it", async () => {
  const role = await asOwner(() =>
    createRole({ name: "Temp", capabilities: ["deploy_apps"] }),
  );
  await asOwner(() => updateMember({ userId: USER_M, roleId: role.id }));
  await assert.rejects(
    () => asOwner(() => deleteRole(role.id)),
    /member|assigned|held/i,
    "a role in use must not vanish out from under its holders",
  );
});

test("a hand-picked capability set is not a role, and a role edit doesn't touch it", async () => {
  // "Custom" - role_id NULL. The member list shows it as such, and it must be
  // immune to edits of the role they were previously on.
  const role = await asOwner(() =>
    createRole({ name: "Ops", capabilities: ["deploy_apps", "view_logs"] }),
  );
  await asOwner(() => updateMember({ userId: USER_M, roleId: role.id }));
  await asOwner(() =>
    updateMember({
      userId: USER_M,
      role: "member",
      capabilities: ["view_logs"],
    }),
  );
  assert.deepEqual(await effectiveCaps(), ["view", "view_logs"]);

  await asOwner(() =>
    updateRole({ id: role.id, name: "Ops", capabilities: ALL_CAPABILITIES }),
  );
  assert.deepEqual(
    await effectiveCaps(),
    ["view", "view_logs"],
    "a custom set must not inherit a role edit",
  );
});

test("a role's two-factor mandate closes the whole team to a member who hasn't enrolled", async () => {
  const role = await asOwner(() =>
    createRole({
      name: "Locked",
      capabilities: [...ALL_CAPABILITIES],
      requireTwoFactor: true,
    }),
  );
  await asOwner(() => updateMember({ userId: USER_M, roleId: role.id }));
  // Not "fewer permissions" - none at all, reads included.
  await assert.rejects(
    () => effectiveCaps(),
    /two-factor/i,
    "an unmet mandate must refuse, not silently downgrade",
  );
  const messages = await callAs(
    USER_M,
    `mutation { createFolder(name: "x", color: null) { id } }`,
  ).catch((e: Error) => [e.message]);
  assert.ok(
    messages.some((m) => /two-factor|not authorized/i.test(m)),
    `the API answered a member under an unmet mandate: ${messages.join("; ")}`,
  );
});

test("a role from another team can't be assigned into this one", async () => {
  // TEAM_B's roles are seeded lazily; forge one directly and try to use it.
  await db.insert(teamRolesTable).values({
    id: "role_foreign",
    teamId: "team_b",
    builtinKey: null,
    name: "Foreign",
    description: null,
    requireTwoFactor: false,
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  await assert.rejects(
    () =>
      asOwner(() => updateMember({ userId: USER_M, roleId: "role_foreign" })),
    /not found|role/i,
    "a cross-team role id must hit nothing",
  );
  assert.deepEqual(await effectiveCaps(), ["view"]);
});

test("the Owner role is locked: it cannot be narrowed into a trap", async () => {
  const [owner] = await db
    .select({ id: teamRolesTable.id })
    .from(teamRolesTable)
    .where(eq(teamRolesTable.builtinKey, "owner"));
  if (!owner) {
    // Roles are seeded lazily - touch them, then re-read.
    await asOwner(() => createRole({ name: "Seeder", capabilities: ["view"] }));
  }
  const [ownerRole] = await db
    .select({ id: teamRolesTable.id })
    .from(teamRolesTable)
    .where(eq(teamRolesTable.builtinKey, "owner"));
  assert.ok(ownerRole, "the built-in Owner role exists once roles are seeded");
  await assert.rejects(
    () =>
      asOwner(() =>
        updateRole({ id: ownerRole.id, name: "Owner", capabilities: ["view"] }),
      ),
    /locked|can't|cannot/i,
    "narrowing Owner would be how a team locks itself out",
  );
});
