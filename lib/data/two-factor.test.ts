import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { twoFactor as twoFactorTable } from "../db/schema/auth";
import { users as usersTable, teams as teamsTable } from "../db/schema/control-plane";
import { runWithIdentity } from "../auth/request-context";
import { seedIdentity, TEAM_A, USER_1 } from "./identity-test-helpers";
import { requireAuth } from "../auth/better-auth";
import { setUserPassword } from "../auth";
import {
  disableTwoFactor,
  regenerateRecoveryCodes,
  startTwoFactorEnrolment,
} from "./two-factor";
import { resetUserTwoFactor } from "./members";

/**
 * The step-up rules around two-factor, and the door they were put in front of.
 *
 * Two things here are only ever true by construction and silently stop being
 * true: that `/api/auth/two-factor/*` cannot be reached over the network (a
 * password-only disable is exactly the attack 2FA exists to survive), and that
 * an instance admin cannot use the recovery hatch on their own account (which
 * would be that same password-only disable, wearing an admin badge).
 */

let db: TestDb;
let pg: PGlite;

const USER_2 = "user_2";
const PASSWORD = "correct-horse-battery";

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
});

after(async () => {
  __resetTestDb();
  await pg.close();
});

beforeEach(async () => {
  await pg.exec(
    `truncate table two_factor, session, account, memberships, users, teams, instance_settings restart identity cascade;`,
  );
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      { id: USER_2, teamId: TEAM_A, role: "member" },
    ],
  });
  await setUserPassword(USER_1, PASSWORD);
});

const asUser = <T>(userId: string, fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId, teamId: TEAM_A }, fn);

/** Put a user in the state "two-factor is on", without a real enrolment. */
async function seedTwoFactor(userId: string) {
  await db
    .update(usersTable)
    .set({ twoFactorEnabled: true })
    .where(eq(usersTable.id, userId));
  await db.insert(twoFactorTable).values({
    id: `tf-${userId}`,
    userId,
    secret: "ciphertext",
    backupCodes: "ciphertext",
    verified: true,
  });
}

/* ------------------------------------------------------------------ */
/* The gate on the plugin's own endpoints                              */
/* ------------------------------------------------------------------ */

/** Post to a Better Auth route the way a browser would: through the handler. */
async function overHttp(path: string, body: unknown) {
  return requireAuth().handler(
    new Request(`http://localhost/api/auth${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

for (const path of [
  "/two-factor/enable",
  "/two-factor/disable",
  "/two-factor/generate-backup-codes",
]) {
  test(`${path} is refused over HTTP`, async () => {
    const res = await overHttp(path, { password: PASSWORD });
    assert.equal(
      res.status,
      403,
      "the plugin's password-only endpoint must not be reachable from a browser",
    );
  });
}

test("the gate leaves the rest of Better Auth alone", async () => {
  // A neighbouring endpoint proves the matcher is scoped to /two-factor/ and
  // has not quietly closed the whole auth surface.
  const res = await overHttp("/sign-in/email", {
    email: "nobody@example.com",
    password: "whatever",
  });
  assert.notEqual(res.status, 403, "sign-in still reaches its own handler");
});

/* ------------------------------------------------------------------ */
/* Step-up on the deplo path                                           */
/* ------------------------------------------------------------------ */

test("enrolment is refused when two-factor is already on", async () => {
  await seedTwoFactor(USER_1);
  await assert.rejects(
    () => asUser(USER_1, () => startTwoFactorEnrolment(PASSWORD)),
    /already on/,
    "re-enrolling would swap the secret without ever asking for a code",
  );
});

test("a wrong password never reaches the code check", async () => {
  await seedTwoFactor(USER_1);
  await assert.rejects(
    () =>
      asUser(USER_1, () =>
        disableTwoFactor({ password: "not-it", code: "000000" }),
      ),
    /password is not correct/,
  );
  const [row] = await db
    .select()
    .from(twoFactorTable)
    .where(eq(twoFactorTable.userId, USER_1));
  assert.ok(row, "the enrolment is still there");
});

test("a team 2FA mandate refuses the disable server-side, not just in the UI", async () => {
  await seedTwoFactor(USER_1);
  await db
    .update(teamsTable)
    .set({ requireTwoFactor: true })
    .where(eq(teamsTable.id, TEAM_A));
  await assert.rejects(
    () =>
      asUser(USER_1, () =>
        disableTwoFactor({ password: PASSWORD, code: "000000" }),
      ),
    /requires two-factor/,
  );
});

test("regenerating recovery codes needs a code, not just the password", async () => {
  await seedTwoFactor(USER_1);
  await assert.rejects(
    () =>
      asUser(USER_1, () =>
        regenerateRecoveryCodes({ password: PASSWORD, code: "000000" }),
      ),
    // The password is right, so whatever refuses this can only be the code.
    (e: Error) => !/password/.test(e.message),
    "a valid password alone must not mint a fresh set of bypass codes",
  );
});

/* ------------------------------------------------------------------ */
/* The admin escape hatch                                              */
/* ------------------------------------------------------------------ */

test("an admin cannot reset their own two-factor", async () => {
  await db
    .update(usersTable)
    .set({ isInstanceAdmin: true })
    .where(eq(usersTable.id, USER_1));
  await seedTwoFactor(USER_1);
  await assert.rejects(
    () => asUser(USER_1, () => resetUserTwoFactor(USER_1)),
    /your own two-factor/,
    "self-reset is the password-only disable this whole module forbids",
  );
});

test("an admin resets someone else's, and only the enrolment goes", async () => {
  await db
    .update(usersTable)
    .set({ isInstanceAdmin: true })
    .where(eq(usersTable.id, USER_1));
  await seedTwoFactor(USER_2);
  await asUser(USER_1, () => resetUserTwoFactor(USER_2));

  const rows = await db
    .select()
    .from(twoFactorTable)
    .where(eq(twoFactorTable.userId, USER_2));
  assert.equal(rows.length, 0, "the enrolment row is gone");
  const [user] = await db
    .select({ enabled: usersTable.twoFactorEnabled })
    .from(usersTable)
    .where(eq(usersTable.id, USER_2));
  assert.equal(user?.enabled, false, "and the flag with it");
});

test("resetting an account that has no two-factor is refused, not a silent no-op", async () => {
  await db
    .update(usersTable)
    .set({ isInstanceAdmin: true })
    .where(eq(usersTable.id, USER_1));
  await assert.rejects(
    () => asUser(USER_1, () => resetUserTwoFactor(USER_2)),
    /does not have two-factor/,
  );
});

test("a non-admin cannot reset anyone", async () => {
  await seedTwoFactor(USER_1);
  await assert.rejects(() => asUser(USER_2, () => resetUserTwoFactor(USER_1)));
});
