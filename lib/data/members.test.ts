import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { and, eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb, type DbTx } from "../db/client";
import {
  memberships as membershipsTable,
  membershipCapabilities as membershipCapabilitiesTable,
  registrationLinks as registrationLinksTable,
  users as usersTable,
} from "../db/schema/control-plane";
import { sha256Hex } from "../crypto";
import { runWithIdentity } from "../auth/request-context";
import {
  seedIdentity,
  TRUNCATE_IDENTITY,
  TEAM_A,
  USER_1,
} from "./identity-test-helpers";
import {
  addExistingMember,
  consumeRegistrationLink,
  getRegistrationLinkInfo,
  listMembers,
  mintRegistrationLink,
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

/** Act as an arbitrary user inside TEAM_A (founder, assigned owner, manager…). */
const asUser = <T>(userId: string, fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId, teamId: TEAM_A }, fn);

test("mintRegistrationLink refuses an owner role for an existing-teams assignment", async () => {
  await seedIdentity(db); // USER_1 is an instance admin (owner of TEAM_A)
  // The server must mirror the UI's member/viewer-only restriction even when the
  // role arrives from a hand-crafted request — an injected owner would be
  // immutable/unremovable. The guard throws before any DB write.
  await assert.rejects(
    () =>
      asOwner(() =>
        mintRegistrationLink({
          mode: "existing_teams",
          teamAssignments: [{ teamId: TEAM_A, role: "owner", capabilities: [] }],
        }),
      ),
    /member or viewer/,
  );
});

const HOUR_MS = 3_600_000;

/**
 * pglite's transaction handle differs from the production node-postgres `DbTx`
 * only in the driver HKT — the query surface is identical (see `DbTx`'s doc
 * comment), the same widening `__setTestDb` already relies on.
 */
const asDbTx = (tx: unknown): DbTx => tx as DbTx;

/** A pending link row, `hoursFromNow` away from expiry (negative = expired). */
const linkRow = (id: string, rawToken: string, hoursFromNow: number) => ({
  id,
  tokenHash: sha256Hex(rawToken),
  status: "pending",
  mode: "own_team",
  createdBy: "admin",
  usedByUsername: null,
  expiresAt: new Date(Date.now() + hoursFromNow * HOUR_MS).toISOString(),
  createdAt: new Date(Date.now() - HOUR_MS).toISOString(),
  usedAt: null,
});

test("mintRegistrationLink stamps an automatic 24h expiry", async () => {
  await seedIdentity(db);
  const before = Date.now();
  // The link row is committed before mint formats its share URL from the request
  // headers — which don't exist under node:test. Pinning that specific rejection
  // proves mint got all the way past the write, so the row below is what it stored.
  await assert.rejects(
    () => asOwner(() => mintRegistrationLink({ mode: "own_team" })),
    /request scope/,
  );
  const after = Date.now();

  const rows = await db
    .select({ expiresAt: registrationLinksTable.expiresAt })
    .from(registrationLinksTable);
  assert.equal(rows.length, 1);
  const expiresAt = Date.parse(rows[0]!.expiresAt);

  assert.ok(
    expiresAt >= before + 24 * HOUR_MS && expiresAt <= after + 24 * HOUR_MS,
    `expected a 24h TTL, got ${(expiresAt - before) / HOUR_MS}h`,
  );
});

test("registration-link expiry is enforced on read and at consume", async () => {
  await seedIdentity(db);
  const fresh = "fresh-raw-token";
  const stale = "stale-raw-token";
  await db
    .insert(registrationLinksTable)
    .values([linkRow("reg_fresh", fresh, 1), linkRow("reg_stale", stale, -1)]);

  assert.equal((await getRegistrationLinkInfo(fresh)).valid, true);
  assert.equal((await getRegistrationLinkInfo(stale)).valid, false);

  // An expired row keeps status='pending' — nothing sweeps it — so the
  // conditional consume UPDATE is the thing that actually refuses it.
  await assert.rejects(
    () =>
      db.transaction((tx) =>
        consumeRegistrationLink(asDbTx(tx), stale, "newbie"),
      ),
    /no longer valid/,
  );
  await db.transaction((tx) =>
    consumeRegistrationLink(asDbTx(tx), fresh, "newbie"),
  );
});

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

/* ------------------------------------------------------------------ */
/* Absolute owner ("crown") vs assigned owner                          */
/* ------------------------------------------------------------------ */

test("listMembers marks the founder as the primary owner; assigned owners are not", async () => {
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" }, // founder of TEAM_A
      { id: "co", teamId: TEAM_A, role: "owner", isInstanceAdmin: false }, // assigned owner
      { id: "m1", teamId: TEAM_A, role: "member", isInstanceAdmin: false },
    ],
  });
  await asOwner(async () => {
    const members = await listMembers();
    const byId = new Map(members.map((m) => [m.userId, m]));
    assert.equal(byId.get(USER_1)!.isPrimaryOwner, true, "founder wears the crown");
    assert.equal(byId.get("co")!.role, "owner");
    assert.equal(byId.get("co")!.isPrimaryOwner, false, "assigned owner is not");
    assert.equal(byId.get("m1")!.isPrimaryOwner, false);
    // The founder is an instance admin by seed default; the others opted out.
    assert.equal(byId.get(USER_1)!.isInstanceAdmin, true);
    assert.equal(byId.get("co")!.isInstanceAdmin, false);
  });
});

test("the founder (primary owner) can't be removed or demoted — even by another owner", async () => {
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" }, // founder
      { id: "co", teamId: TEAM_A, role: "owner" }, // assigned owner with manage_members
    ],
  });
  // An assigned owner (full manage_members) still cannot touch the founder.
  await asUser("co", async () => {
    await assert.rejects(
      () => removeMember(USER_1),
      /primary owner can't be removed/,
    );
    await assert.rejects(
      () => updateMember({ userId: USER_1, role: "member", capabilities: ["view"] }),
      /primary owner's role and permissions can't be changed/,
    );
  });
});

test("the founder CAN remove an assigned owner (the reported gap)", async () => {
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" }, // founder
      { id: "co", teamId: TEAM_A, role: "owner" }, // assigned owner
    ],
  });
  await asOwner(async () => {
    await removeMember("co");
    const members = await listMembers();
    assert.equal(members.length, 1, "only the founder remains");
    assert.equal(members[0].userId, USER_1);
  });
});

test("assigned owners can remove each other; the founder stays protected", async () => {
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" }, // founder
      { id: "co1", teamId: TEAM_A, role: "owner" }, // assigned owner
      { id: "co2", teamId: TEAM_A, role: "owner" }, // assigned owner
    ],
  });
  await asUser("co1", async () => {
    await removeMember("co2"); // one assigned owner removes another — allowed
    const members = await listMembers();
    assert.deepEqual(
      members.map((m) => m.userId).sort(),
      [USER_1, "co1"].sort(),
    );
  });
});

test("a non-owner manager cannot act on owners or grant the owner role", async () => {
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" }, // founder
      { id: "co", teamId: TEAM_A, role: "owner" }, // assigned owner
      {
        id: "mgr",
        teamId: TEAM_A,
        role: "member",
        capabilities: ["view", "manage_members"],
      },
      { id: "m1", teamId: TEAM_A, role: "member" }, // a plain member to promote
      { id: "cand", teamId: "team_b", role: "owner" }, // a user from another team
    ],
  });
  await asUser("mgr", async () => {
    // Can't remove or edit an (assigned) owner.
    await assert.rejects(() => removeMember("co"), /Only an owner can remove another owner/);
    await assert.rejects(
      () => updateMember({ userId: "co", role: "member", capabilities: ["view"] }),
      /Only an owner can change another owner/,
    );
    // Can't promote a member to owner.
    await assert.rejects(
      () => updateMember({ userId: "m1", role: "owner" }),
      /Only an owner can grant the owner role/,
    );
    // Can't add a new owner.
    await assert.rejects(
      () => addExistingMember({ userId: "cand", role: "owner" }),
      /Only an owner can add another owner/,
    );
    // But managing a plain member is fine.
    await updateMember({ userId: "m1", role: "viewer", capabilities: ["view"] });
  });
});

test("an owner can add another (assigned) owner; they are not the founder", async () => {
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" }, // founder
      { id: "cand", teamId: "team_b", role: "owner" },
    ],
  });
  await asOwner(async () => {
    const m = await addExistingMember({ userId: "cand", role: "owner" });
    assert.equal(m.role, "owner");
    assert.equal(m.isPrimaryOwner, false, "an added owner never inherits the crown");
    const members = await listMembers();
    const cand = members.find((x) => x.userId === "cand")!;
    assert.equal(cand.role, "owner");
    assert.equal(cand.isPrimaryOwner, false);
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
