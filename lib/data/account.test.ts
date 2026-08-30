import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { users as usersTable } from "../db/schema/control-plane";
import { runWithIdentity } from "../auth/request-context";
import { seedIdentity, TEAM_A, USER_1 } from "./identity-test-helpers";
import { updateProfile } from "./account";

/**
 * The handle is instance-wide and unique, so a rename has to refuse a taken one
 * and an invalid one before it ever reaches the unique index.
 */

let db: TestDb;
let pg: PGlite;

const USER_2 = "user_2";

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
    `truncate table session, account, memberships, users, teams restart identity cascade;`,
  );
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      { id: USER_2, teamId: TEAM_A, role: "member" },
    ],
  });
});

const asUser1 = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);

const readUser = async (id: string) =>
  (
    await db
      .select({ name: usersTable.name, username: usersTable.username })
      .from(usersTable)
      .where(eq(usersTable.id, id))
      .limit(1)
  )[0];

test("updateProfile: renames the handle alongside the name", async () => {
  await asUser1(() => updateProfile({ name: "Ada", username: "Ada Lovelace" }));
  const row = await readUser(USER_1);
  assert.equal(row?.name, "Ada");
  assert.equal(row?.username, "ada-lovelace", "normalized before it is stored");
});

test("updateProfile: leaves the handle alone when none is given", async () => {
  await asUser1(() => updateProfile({ name: "Ada" }));
  assert.equal((await readUser(USER_1))?.username, USER_1);
});

test("updateProfile: refuses a handle another account holds", async () => {
  await assert.rejects(
    asUser1(() => updateProfile({ name: "Ada", username: USER_2 })),
    /already taken/,
  );
  assert.equal((await readUser(USER_1))?.username, USER_1, "nothing written");
});

test("updateProfile: refuses a handle that is too short", async () => {
  await assert.rejects(
    asUser1(() => updateProfile({ name: "Ada", username: "ab" })),
    /at least 3 characters/,
  );
});

test("updateProfile: keeping your own handle is not a collision", async () => {
  await asUser1(() => updateProfile({ name: "Ada", username: USER_1 }));
  const row = await readUser(USER_1);
  assert.equal(row?.username, USER_1);
  assert.equal(row?.name, "Ada");
});
