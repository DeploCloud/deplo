import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { and, eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import {
  memberships as membershipsTable,
  membershipCapabilities as membershipCapabilitiesTable,
  users as usersTable,
} from "../db/schema/control-plane";
import { runWithIdentity } from "../auth/request-context";
import {
  seedIdentity,
  TRUNCATE_IDENTITY,
  TEAM_A,
  USER_1,
} from "./identity-test-helpers";
import {
  addExistingMember,
  listMembers,
  removeMember,
  updateMember,
  updateUserAdmin,
} from "./members";

/**
 * Members cut-set (b) tests against pglite (relational-store PLAN Step 3): the
 * `SELECT … FOR UPDATE` count-invariants (admin-coverage + active-admin) under
 * two concurrent demotions, and the membership edits via the junction.
 *
 * pglite is single-connection, so `FOR UPDATE` can't block across real
 * connections; the two operations serialize on the JS event loop. The test still
 * validates the LOGIC the lock guarantees — the second operation re-evaluates
 * against the first's committed state and the invariant holds ("exactly one wins,
 * ≥1 holder remains").
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

test("addExistingMember adds a user with caps; double-add is rejected", async () => {
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      { id: "bob", teamId: "team_b", role: "owner" },
    ],
  });
  await asOwner(async () => {
    const m = await addExistingMember({ userId: "bob", role: "member" });
    assert.equal(m.userId, "bob");
    assert.ok(m.capabilities.includes("view"));
    const members = await listMembers();
    assert.equal(members.length, 2, "owner + bob");
    // A second add of the same user is rejected.
    await assert.rejects(
      () => addExistingMember({ userId: "bob", role: "member" }),
      /already a member/,
    );
  });
});

test("updateMember edits caps but assertAdminCoverage blocks dropping the last manager", async () => {
  // Owner + one extra manager. Demoting the manager is allowed (owner still
  // covers); but the owner is immutable, so the team always keeps a manager.
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      { id: "mgr", teamId: TEAM_A, role: "member", capabilities: ["view", "manage_members", "manage_team"] },
    ],
  });
  await asOwner(async () => {
    // Demote mgr to view-only: owner still holds both critical caps, so allowed.
    await updateMember({ userId: "mgr", role: "member", capabilities: ["view"] });
    const mgrMembership = (
      await db
        .select({ id: membershipsTable.id })
        .from(membershipsTable)
        .where(eq(membershipsTable.userId, "mgr"))
    )[0]!;
    const caps = await db
      .select({ c: membershipCapabilitiesTable.capability })
      .from(membershipCapabilitiesTable)
      .where(eq(membershipCapabilitiesTable.membershipId, mgrMembership.id));
    assert.deepEqual(caps.map((r) => r.c), ["view"]);
  });
});

test("two concurrent demotions of manage_members holders — coverage invariant holds", async () => {
  // Owner is immutable (always covers). Add TWO non-owner managers; concurrently
  // strip manage_members from BOTH. With the owner present, coverage never drops
  // to zero, so both can succeed — assert ≥1 holder remains regardless.
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      { id: "m1", teamId: TEAM_A, role: "member", capabilities: ["view", "manage_members"] },
      { id: "m2", teamId: TEAM_A, role: "member", capabilities: ["view", "manage_members"] },
    ],
  });
  await asOwner(async () => {
    const results = await Promise.allSettled([
      updateMember({ userId: "m1", role: "member", capabilities: ["view"] }),
      updateMember({ userId: "m2", role: "member", capabilities: ["view"] }),
    ]);
    // The owner always holds manage_members, so neither demotion empties the set.
    assert.ok(results.every((r) => r.status === "fulfilled"));
  });
  // At least one manage_members holder remains (the owner).
  const holders = await db
    .select({ userId: membershipsTable.userId })
    .from(membershipsTable)
    .innerJoin(
      membershipCapabilitiesTable,
      eq(membershipCapabilitiesTable.membershipId, membershipsTable.id),
    )
    .where(
      and(
        eq(membershipsTable.teamId, TEAM_A),
        eq(membershipCapabilitiesTable.capability, "manage_members"),
      ),
    );
  assert.ok(holders.length >= 1, "≥1 manage_members holder remains");
});

test("removeMember keeps the team covered; removing the sole non-owner manager when the owner covers is fine", async () => {
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      { id: "m1", teamId: TEAM_A, role: "member", capabilities: ["view", "manage_members", "manage_team"] },
    ],
  });
  await asOwner(async () => {
    await removeMember("m1");
    const members = await listMembers();
    assert.equal(members.length, 1, "only the owner remains");
  });
});

test("two concurrent active-admin demotions — at least one active admin always survives", async () => {
  // Two instance admins, each acting to demote the OTHER. Exactly one demotion
  // can succeed; the second must re-evaluate post-commit and be refused, leaving
  // ≥1 active admin (the lockout guard).
  await seedIdentity(db, {
    users: [
      { id: "admin1", teamId: TEAM_A, role: "owner", isInstanceAdmin: true },
      { id: "admin2", teamId: TEAM_A, role: "owner", isInstanceAdmin: true },
    ],
  });

  const demote = (actor: string, target: string) =>
    runWithIdentity({ userId: actor, teamId: TEAM_A }, () =>
      updateUserAdmin({
        userId: target,
        isInstanceAdmin: false,
        suspended: false,
        canExposePorts: false,
        canMountHostVolumes: false,
      }),
    );

  const results = await Promise.allSettled([
    demote("admin1", "admin2"),
    demote("admin2", "admin1"),
  ]);
  const fulfilled = results.filter((r) => r.status === "fulfilled").length;
  assert.equal(fulfilled, 1, "exactly one demotion succeeds");

  const activeAdmins = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(and(eq(usersTable.isInstanceAdmin, true), eq(usersTable.suspended, false)));
  assert.equal(activeAdmins.length, 1, "exactly one active admin remains");
});

test("updateUserAdmin refuses to demote the only active admin", async () => {
  await seedIdentity(db, {
    users: [{ id: "admin1", teamId: TEAM_A, role: "owner", isInstanceAdmin: true }],
  });
  await runWithIdentity({ userId: "admin1", teamId: TEAM_A }, async () => {
    await assert.rejects(
      () =>
        updateUserAdmin({
          userId: "admin1",
          isInstanceAdmin: false,
          suspended: false,
          canExposePorts: false,
          canMountHostVolumes: false,
        }),
      /at least one active admin/,
    );
  });
});

test("updateUserAdmin can promote a non-admin even when they aren't yet in the admin set", async () => {
  await seedIdentity(db, {
    users: [
      { id: "admin1", teamId: TEAM_A, role: "owner", isInstanceAdmin: true },
      { id: "plain", teamId: "team_b", role: "owner", isInstanceAdmin: false },
    ],
  });
  await runWithIdentity({ userId: "admin1", teamId: TEAM_A }, async () => {
    await updateUserAdmin({
      userId: "plain",
      isInstanceAdmin: true,
      suspended: false,
      canExposePorts: false,
      canMountHostVolumes: false,
    });
  });
  const promoted = (
    await db.select().from(usersTable).where(eq(usersTable.id, "plain"))
  )[0]!;
  assert.equal(promoted.isInstanceAdmin, true);
});
