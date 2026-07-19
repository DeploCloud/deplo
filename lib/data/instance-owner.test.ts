import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import {
  instanceSettings,
  users as usersTable,
} from "../db/schema/control-plane";
import { verifyPassword } from "../crypto";
import { runWithIdentity } from "../auth/request-context";
import {
  seedIdentity,
  TRUNCATE_IDENTITY,
  TEAM_A,
} from "./identity-test-helpers";
import { updateUserAdmin } from "./members";
import {
  instanceOwnerUserId,
  transferInstanceOwner,
  viewerIsInstanceOwner,
} from "./instance-owner";

/**
 * Instance-owner invariants — the lockout this whole feature exists to close.
 *
 * Before the crown, `updateUserAdmin`'s only guard was "≥1 ACTIVE admin must
 * survive", which the ATTACKER satisfies by being that admin. So any instance
 * admin could, on any other admin (the first account included), clear the admin
 * flag, set `suspended` so login fails, and overwrite `password_hash` — three
 * routes to one takeover, with no user-deletion path and no self-service reset to
 * climb back through. These tests pin all three shut, and pin the transfer that
 * keeps the crown from being a dead end.
 */

let db: TestDb;
let pg: PGlite;

const OWNER = "owner1";
const ADMIN = "admin2";
const PLAIN = "member3";
/** The password `seedIdentity` hashes into every seeded user by default. */
const SEEDED_PW = "password1";

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

const asUser = <T>(userId: string, fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId, teamId: TEAM_A }, fn);

/** Two instance admins + a plain member, with the crown on OWNER. */
async function seedOwnedInstance() {
  await seedIdentity(db, {
    users: [
      { id: OWNER, teamId: TEAM_A, role: "owner", isInstanceAdmin: true },
      { id: ADMIN, teamId: TEAM_A, role: "owner", isInstanceAdmin: true },
      { id: PLAIN, teamId: TEAM_A, role: "member", isInstanceAdmin: false },
    ],
  });
  await db.insert(instanceSettings).values({
    id: "default",
    ownerUserId: OWNER,
    updatedAt: new Date().toISOString(),
  });
}

/** The full input shape; every field is required by updateUserAdmin. */
const edit = (userId: string, patch: Partial<Parameters<typeof updateUserAdmin>[0]> = {}) => ({
  userId,
  isInstanceAdmin: true,
  suspended: false,
  canExposePorts: false,
  canMountHostVolumes: false,
  ...patch,
});

const userRow = async (id: string) =>
  (
    await db
      .select({
        isInstanceAdmin: usersTable.isInstanceAdmin,
        suspended: usersTable.suspended,
        passwordHash: usersTable.passwordHash,
      })
      .from(usersTable)
      .where(eq(usersTable.id, id))
      .limit(1)
  )[0]!;

/* ------------------------------------------------------------------ */
/* The three takeover routes, closed                                   */
/* ------------------------------------------------------------------ */

test("another admin cannot DEMOTE the instance owner", async () => {
  await seedOwnedInstance();
  await asUser(ADMIN, async () => {
    await assert.rejects(
      () => updateUserAdmin(edit(OWNER, { isInstanceAdmin: false })),
      /Only the instance owner can edit/,
    );
  });
  assert.equal((await userRow(OWNER)).isInstanceAdmin, true);
});

test("another admin cannot SUSPEND the instance owner", async () => {
  await seedOwnedInstance();
  await asUser(ADMIN, async () => {
    await assert.rejects(
      () => updateUserAdmin(edit(OWNER, { suspended: true })),
      /Only the instance owner can edit/,
    );
  });
  assert.equal((await userRow(OWNER)).suspended, false);
});

test("another admin cannot RESET the instance owner's password", async () => {
  await seedOwnedInstance();
  const before = (await userRow(OWNER)).passwordHash;
  await asUser(ADMIN, async () => {
    await assert.rejects(
      () => updateUserAdmin(edit(OWNER, { newPassword: "hijacked-me" })),
      /Only the instance owner can edit/,
    );
  });
  const after = await userRow(OWNER);
  assert.equal(after.passwordHash, before, "the hash must be untouched");
  assert.ok(
    verifyPassword(SEEDED_PW, after.passwordHash),
    "the owner's original password still works",
  );
});

test("the owner cannot uncrown themselves by dropping their own admin flag", async () => {
  await seedOwnedInstance();
  await asUser(OWNER, async () => {
    await assert.rejects(
      () => updateUserAdmin(edit(OWNER, { isInstanceAdmin: false })),
      /always an instance admin/,
    );
  });
  assert.equal((await userRow(OWNER)).isInstanceAdmin, true);
});

/* ------------------------------------------------------------------ */
/* What the guard must NOT break                                       */
/* ------------------------------------------------------------------ */

test("the owner can still edit their own account (password included)", async () => {
  await seedOwnedInstance();
  await asUser(OWNER, () =>
    updateUserAdmin(edit(OWNER, { newPassword: "a-new-password" })),
  );
  const row = await userRow(OWNER);
  assert.ok(verifyPassword("a-new-password", row.passwordHash));
  assert.equal(row.isInstanceAdmin, true);
});

test("the owner can demote and suspend OTHER admins", async () => {
  await seedOwnedInstance();
  await asUser(OWNER, () =>
    updateUserAdmin(edit(ADMIN, { isInstanceAdmin: false, suspended: true })),
  );
  const row = await userRow(ADMIN);
  assert.equal(row.isInstanceAdmin, false);
  assert.equal(row.suspended, true);
});

test("admins can still edit each other when neither is the owner", async () => {
  await seedOwnedInstance();
  await asUser(ADMIN, () =>
    updateUserAdmin(edit(PLAIN, { isInstanceAdmin: true })),
  );
  assert.equal((await userRow(PLAIN)).isInstanceAdmin, true);
});

test("an UNOWNED instance behaves exactly as before (no guard fires)", async () => {
  // The pre-0038 state: a row that was never written, or an instance with no
  // admin to backfill from. The guards must no-op rather than wedge every edit.
  await seedIdentity(db, {
    users: [
      { id: OWNER, teamId: TEAM_A, role: "owner", isInstanceAdmin: true },
      { id: ADMIN, teamId: TEAM_A, role: "owner", isInstanceAdmin: true },
    ],
  });
  assert.equal(await instanceOwnerUserId(), null);
  await asUser(ADMIN, () =>
    updateUserAdmin(edit(OWNER, { isInstanceAdmin: false })),
  );
  assert.equal((await userRow(OWNER)).isInstanceAdmin, false);
});

test("the last-active-admin invariant still holds ahead of the owner guard", async () => {
  // The owner demoting the only OTHER admin is fine; demoting themselves is
  // caught by the owner guard, and the count invariant stays intact either way.
  await seedOwnedInstance();
  await asUser(OWNER, () =>
    updateUserAdmin(edit(ADMIN, { isInstanceAdmin: false })),
  );
  await asUser(OWNER, async () => {
    await assert.rejects(
      () => updateUserAdmin(edit(OWNER, { isInstanceAdmin: false })),
      /always an instance admin/,
    );
  });
  assert.equal((await userRow(OWNER)).isInstanceAdmin, true);
});

/* ------------------------------------------------------------------ */
/* Transfer — the crown is not a dead end                              */
/* ------------------------------------------------------------------ */

test("only the owner can transfer ownership", async () => {
  await seedOwnedInstance();
  await asUser(ADMIN, async () => {
    await assert.rejects(
      () => transferInstanceOwner({ userId: ADMIN, password: SEEDED_PW }),
      /Only the instance owner can transfer/,
    );
  });
  assert.equal(await instanceOwnerUserId(), OWNER);
});

test("transfer requires the caller's own password", async () => {
  await seedOwnedInstance();
  await asUser(OWNER, async () => {
    await assert.rejects(
      () => transferInstanceOwner({ userId: ADMIN, password: "wrong" }),
      /password is not correct/,
    );
  });
  assert.equal(await instanceOwnerUserId(), OWNER);
});

test("transfer refuses a non-admin and a suspended target", async () => {
  await seedOwnedInstance();
  await asUser(OWNER, async () => {
    await assert.rejects(
      () => transferInstanceOwner({ userId: PLAIN, password: SEEDED_PW }),
      /only transfer ownership to an instance admin/,
    );
    await updateUserAdmin(edit(ADMIN, { suspended: true }));
    await assert.rejects(
      () => transferInstanceOwner({ userId: ADMIN, password: SEEDED_PW }),
      /suspended account/,
    );
  });
  assert.equal(await instanceOwnerUserId(), OWNER);
});

test("a successful transfer moves the crown — and the protections with it", async () => {
  await seedOwnedInstance();
  await asUser(OWNER, () =>
    transferInstanceOwner({ userId: ADMIN, password: SEEDED_PW }),
  );
  assert.equal(await instanceOwnerUserId(), ADMIN);

  // The new owner is now the untouchable one...
  await asUser(OWNER, async () => {
    await assert.rejects(
      () => updateUserAdmin(edit(ADMIN, { suspended: true })),
      /Only the instance owner can edit/,
    );
  });
  // ...and the old owner is an ordinary admin again, demotable by the new owner.
  await asUser(ADMIN, () =>
    updateUserAdmin(edit(OWNER, { isInstanceAdmin: false })),
  );
  assert.equal((await userRow(OWNER)).isInstanceAdmin, false);
});

test("viewerIsInstanceOwner reflects the crown, not the admin flag", async () => {
  await seedOwnedInstance();
  assert.equal(await asUser(OWNER, viewerIsInstanceOwner), true);
  assert.equal(await asUser(ADMIN, viewerIsInstanceOwner), false);
  assert.equal(await asUser(PLAIN, viewerIsInstanceOwner), false);
});
