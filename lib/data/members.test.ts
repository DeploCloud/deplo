import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { and, eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb, type DbTx } from "../db/client";
import {
  memberships as membershipsTable,
  membershipCapabilities as membershipCapabilitiesTable,
} from "../db/schema/control-plane/access-control";
import {
  registrationLinks as registrationLinksTable,
  users as usersTable,
} from "../db/schema/control-plane/identity";
import { sha256Hex, decryptSecret } from "../crypto";
import { runWithIdentity } from "../auth/request-context";
import {
  seedIdentity,
  TRUNCATE_IDENTITY,
  TEAM_A,
  TEAM_B,
  USER_1,
} from "./identity-test-helpers";
import { addExistingMember, updateMember } from "./members/assignment";
import { updateUserAdmin } from "./members/instance-users";
import {
  mintRegistrationLink,
  revealRegistrationLink,
  revokeAllRegistrationLinks,
} from "./members/registration-links";
import {
  consumeRegistrationLink,
  getRegistrationLinkInfo,
} from "./members/registration-redeem";
import { removeMember } from "./members/removal";
import { listMembers } from "./members/roster";
import { searchUsers } from "./members/user-search";

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

test("mintRegistrationLink refuses an owner role for an existing-teams assignment", async () => {
  await seedIdentity(db);
  // The server mirrors the UI's member/viewer-only restriction: an injected owner would be unremovable.
  await assert.rejects(
    () =>
      asOwner(() =>
        mintRegistrationLink({
          mode: "existing_teams",
          teamAssignments: [
            { teamId: TEAM_A, role: "owner", capabilities: [] },
          ],
        }),
      ),
    /member or viewer/,
  );
});

const HOUR_MS = 3_600_000;

// pglite's transaction handle differs from the production `DbTx` only in the driver HKT.
const asDbTx = (tx: unknown): DbTx => tx as DbTx;

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
  const { link } = await asOwner(() =>
    mintRegistrationLink({ mode: "own_team" }),
  );
  const after = Date.now();
  assert.match(link, /\/register\//, "the share URL carries the raw token");

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

test("mintRegistrationLink keeps the token readable back, and the hash still matches", async () => {
  await seedIdentity(db);
  await asOwner(() => mintRegistrationLink({ mode: "own_team" }));

  const [row] = await db
    .select({
      tokenHash: registrationLinksTable.tokenHash,
      tokenEnc: registrationLinksTable.tokenEnc,
    })
    .from(registrationLinksTable);

  assert.ok(
    row!.tokenEnc,
    "the token is kept encrypted so it can be shown again",
  );
  const token = decryptSecret(row!.tokenEnc!);
  assert.notEqual(token, "", "and it decrypts");
  // The HASH is what /register looks the link up by: a token that hashes elsewhere is a different link.
  assert.equal(sha256Hex(token), row!.tokenHash);
});

test("revealRegistrationLink refuses a link that can no longer be used", async () => {
  await seedIdentity(db);
  await db.insert(registrationLinksTable).values([
    {
      ...linkRow("reg_used", "used-token", 12),
      status: "used",
      usedByUsername: "bob",
    },
    { ...linkRow("reg_revoked", "revoked-token", 12), status: "revoked" },
    linkRow("reg_expired", "expired-token", -1),
    // Pending and alive, but minted before token_enc existed (migration 0048).
    linkRow("reg_legacy", "legacy-token", 12),
  ]);

  await asOwner(async () => {
    // Each check runs BEFORE the token is decrypted, so none of them leaks a URL.
    await assert.rejects(
      () => revealRegistrationLink("reg_used"),
      /already used by @bob/,
    );
    await assert.rejects(
      () => revealRegistrationLink("reg_revoked"),
      /revoked/,
    );
    await assert.rejects(
      () => revealRegistrationLink("reg_expired"),
      /expired/,
    );
    await assert.rejects(
      () => revealRegistrationLink("reg_legacy"),
      /before links could be shown again/,
    );
    await assert.rejects(
      () => revealRegistrationLink("reg_nope"),
      /not found/i,
    );
  });
});

test("revealRegistrationLink is instance-admin only", async () => {
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      {
        id: "user_plain",
        teamId: TEAM_A,
        role: "member",
        isInstanceAdmin: false,
      },
    ],
  });
  await db.insert(registrationLinksTable).values(linkRow("reg_1", "raw", 12));
  await assert.rejects(
    () => asUser("user_plain", () => revealRegistrationLink("reg_1")),
    /Only an instance admin/,
  );
});

test("revokeAllRegistrationLinks kills every pending link and nothing else", async () => {
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      {
        id: "user_plain",
        teamId: TEAM_A,
        role: "member",
        isInstanceAdmin: false,
      },
    ],
  });
  await db.insert(registrationLinksTable).values([
    linkRow("reg_mine", "mine", 12),
    { ...linkRow("reg_theirs", "theirs", 12), createdBy: "someone-else" },
    linkRow("reg_expired", "expired", -1),
    {
      ...linkRow("reg_used", "used", 12),
      status: "used",
      usedByUsername: "bob",
    },
  ]);

  await assert.rejects(
    () => asUser("user_plain", () => revokeAllRegistrationLinks()),
    /Only an instance admin/,
  );

  assert.equal(await asOwner(() => revokeAllRegistrationLinks()), 3);
  const rows = await db
    .select({
      id: registrationLinksTable.id,
      status: registrationLinksTable.status,
    })
    .from(registrationLinksTable);
  assert.deepEqual(Object.fromEntries(rows.map((r) => [r.id, r.status])), {
    reg_mine: "revoked",
    reg_theirs: "revoked",
    reg_expired: "revoked",
    reg_used: "used",
  });
  assert.equal(await asOwner(() => revokeAllRegistrationLinks()), 0);
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

  // An expired row keeps status='pending', so the conditional consume UPDATE is what refuses it.
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
    await assert.rejects(
      () => addExistingMember({ userId: "bob", role: "member" }),
      /already a member/,
    );
  });
});

test("updateMember edits caps but assertAdminCoverage blocks dropping the last manager", async () => {
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      {
        id: "mgr",
        teamId: TEAM_A,
        role: "member",
        capabilities: ["view", "manage_members", "manage_team"],
      },
    ],
  });
  await asOwner(async () => {
    await updateMember({
      userId: "mgr",
      role: "member",
      capabilities: ["view"],
    });
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
    assert.deepEqual(
      caps.map((r) => r.c),
      ["view"],
    );
  });
});

test("two concurrent demotions of manage_members holders - coverage invariant holds", async () => {
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      {
        id: "m1",
        teamId: TEAM_A,
        role: "member",
        capabilities: ["view", "manage_members"],
      },
      {
        id: "m2",
        teamId: TEAM_A,
        role: "member",
        capabilities: ["view", "manage_members"],
      },
    ],
  });
  await asOwner(async () => {
    const results = await Promise.allSettled([
      updateMember({ userId: "m1", role: "member", capabilities: ["view"] }),
      updateMember({ userId: "m2", role: "member", capabilities: ["view"] }),
    ]);
    assert.ok(results.every((r) => r.status === "fulfilled"));
  });
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
      {
        id: "m1",
        teamId: TEAM_A,
        role: "member",
        capabilities: ["view", "manage_members", "manage_team"],
      },
    ],
  });
  await asOwner(async () => {
    await removeMember("m1");
    const members = await listMembers();
    assert.equal(members.length, 1, "only the owner remains");
  });
});

test("listMembers marks the founder as the primary owner; assigned owners are not", async () => {
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      { id: "co", teamId: TEAM_A, role: "owner", isInstanceAdmin: false },
      { id: "m1", teamId: TEAM_A, role: "member", isInstanceAdmin: false },
    ],
  });
  await asOwner(async () => {
    const members = await listMembers();
    const byId = new Map(members.map((m) => [m.userId, m]));
    assert.equal(
      byId.get(USER_1)!.isPrimaryOwner,
      true,
      "founder wears the crown",
    );
    assert.equal(byId.get("co")!.role, "owner");
    assert.equal(
      byId.get("co")!.isPrimaryOwner,
      false,
      "assigned owner is not",
    );
    assert.equal(byId.get("m1")!.isPrimaryOwner, false);
    assert.equal(byId.get(USER_1)!.isInstanceAdmin, true);
    assert.equal(byId.get("co")!.isInstanceAdmin, false);
  });
});

test("listMembers counts each member's tokens and agents reaching the team, nothing more", async () => {
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      { id: "m1", teamId: TEAM_A, role: "member", isInstanceAdmin: false },
    ],
  });
  const { createToken } = await import("./tokens/mint");
  await runWithIdentity({ userId: USER_1, teamId: TEAM_A }, async () => {
    await createToken({ name: "ci", capabilities: ["view"] });
    const { token } = await createToken({
      name: "agent",
      capabilities: ["view"],
    });
    await pg.query(
      `update api_tokens set mcp_last_used_at = now() where id = $1`,
      [token.id],
    );
  });
  await asOwner(async () => {
    const byId = new Map((await listMembers()).map((m) => [m.userId, m]));
    assert.equal(byId.get(USER_1)!.tokenCount, 2);
    assert.equal(byId.get(USER_1)!.agentCount, 1);
    assert.equal(byId.get("m1")!.tokenCount, 0);
    // The DTO carries counts only: no id, prefix or name of a credential.
    const dump = JSON.stringify(byId.get(USER_1));
    assert.ok(!dump.includes("deplo_"), dump);
    assert.ok(!dump.includes("tok_"), dump);
  });
});

test("the founder (primary owner) can't be removed or demoted - even by another owner", async () => {
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      { id: "co", teamId: TEAM_A, role: "owner" },
    ],
  });
  await asUser("co", async () => {
    await assert.rejects(
      () => removeMember(USER_1),
      /primary owner can't be removed/,
    );
    await assert.rejects(
      () =>
        updateMember({
          userId: USER_1,
          role: "member",
          capabilities: ["view"],
        }),
      /primary owner's role and permissions can't be changed/,
    );
  });
});

test("the founder CAN remove an assigned owner (the reported gap)", async () => {
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      { id: "co", teamId: TEAM_A, role: "owner" },
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
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      { id: "co1", teamId: TEAM_A, role: "owner" },
      { id: "co2", teamId: TEAM_A, role: "owner" },
    ],
  });
  await asUser("co1", async () => {
    await removeMember("co2");
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
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      { id: "co", teamId: TEAM_A, role: "owner" },
      {
        id: "mgr",
        teamId: TEAM_A,
        role: "member",
        capabilities: ["view", "manage_members"],
      },
      { id: "m1", teamId: TEAM_A, role: "member" },
      { id: "cand", teamId: "team_b", role: "owner" },
    ],
  });
  await asUser("mgr", async () => {
    await assert.rejects(
      () => removeMember("co"),
      /Only an owner can remove another owner/,
    );
    await assert.rejects(
      () =>
        updateMember({ userId: "co", role: "member", capabilities: ["view"] }),
      /Only an owner can change another owner/,
    );
    await assert.rejects(
      () => updateMember({ userId: "m1", role: "owner" }),
      /Only an owner can grant the owner role/,
    );
    await assert.rejects(
      () => addExistingMember({ userId: "cand", role: "owner" }),
      /Only an owner can add another owner/,
    );
    await updateMember({
      userId: "m1",
      role: "viewer",
      capabilities: ["view"],
    });
  });
});

test("an owner can add another (assigned) owner; they are not the founder", async () => {
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      { id: "cand", teamId: "team_b", role: "owner" },
    ],
  });
  await asOwner(async () => {
    const m = await addExistingMember({ userId: "cand", role: "owner" });
    assert.equal(m.role, "owner");
    assert.equal(
      m.isPrimaryOwner,
      false,
      "an added owner never inherits the crown",
    );
    const members = await listMembers();
    const cand = members.find((x) => x.userId === "cand")!;
    assert.equal(cand.role, "owner");
    assert.equal(cand.isPrimaryOwner, false);
  });
});

test("two concurrent active-admin demotions - at least one active admin always survives", async () => {
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
    .where(
      and(
        eq(usersTable.isInstanceAdmin, true),
        eq(usersTable.suspended, false),
      ),
    );
  assert.equal(activeAdmins.length, 1, "exactly one active admin remains");
});

test("updateUserAdmin refuses to demote the only active admin", async () => {
  await seedIdentity(db, {
    users: [
      { id: "admin1", teamId: TEAM_A, role: "owner", isInstanceAdmin: true },
    ],
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

// The picker is bounded by the actor's own reach: it must never list every account on the instance.
test("searchUsers offers colleagues, and a stranger only by exact username", async () => {
  await seedIdentity(db, {
    teams: [
      { id: TEAM_A, slug: "alpha" },
      { id: TEAM_B, slug: "beta" },
      { id: "team_c", slug: "gamma" },
    ],
    users: [
      // NOT an instance admin: an admin keeps the full roster on purpose.
      { id: USER_1, teamId: TEAM_A, role: "owner", isInstanceAdmin: false },
      {
        id: "u_colleague",
        teamId: TEAM_B,
        role: "member",
        isInstanceAdmin: false,
      },
      {
        id: "u_stranger",
        teamId: "team_c",
        role: "owner",
        isInstanceAdmin: false,
      },
    ],
  });
  await db.insert(membershipsTable).values({
    id: "mem_user_1_b",
    userId: USER_1,
    teamId: TEAM_B,
    role: "member",
    createdAt: "2026-01-01T00:00:00.000Z",
  });

  const names = async (q: string) =>
    (await asOwner(() => searchUsers(q))).map((u) => u.username).sort();

  assert.deepEqual(
    await names(""),
    ["u_colleague"],
    "the empty picker shows the people the actor already works with",
  );
  assert.deepEqual(
    await names("u_"),
    ["u_colleague"],
    "a substring must not sweep in somebody from another tenant",
  );
  assert.deepEqual(
    await names("u_stranger"),
    ["u_stranger"],
    "naming an account exactly is still how you add somebody you know of",
  );
});
