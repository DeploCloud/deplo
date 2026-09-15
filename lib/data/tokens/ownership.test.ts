import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { makeTestDb, type TestDb } from "../../db/test-harness";
import { __setTestDb, __resetTestDb } from "../../db/client";
import { apiTokens } from "../../db/schema/control-plane/api-tokens";
import { runWithIdentity } from "../../auth/request-context";
import { ALL_CAPABILITIES } from "../../types/identity";
import { seedIdentity, TEAM_A, TEAM_B, USER_1 } from "../leaf-test-helpers";
import { listTokens } from "./listing";
import { createToken, updateToken } from "./mint";
import { revokeToken } from "./revoke";
import {
  TRUNCATE,
  asUser1,
  asUser1InB,
  alsoMemberOfB,
  seedMembership,
} from "./tokens-test-helpers";

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
  await pg.exec(TRUNCATE);
  await seedIdentity(db);
});

test("a cross-team id hits nothing, and says so", async () => {
  await pg.exec(TRUNCATE);
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      { id: "user_2", teamId: TEAM_B, role: "owner" },
    ],
  });
  const bId = await runWithIdentity(
    { userId: "user_2", teamId: TEAM_B },
    async () => (await createToken({ name: "B-token" })).token.id,
  );
  await asUser1(async () => {
    await assert.rejects(() => revokeToken(bId), /Token not found/);
    await assert.rejects(
      () => updateToken({ id: bId, name: "Stolen" }),
      /Token not found/,
    );
  });
  assert.equal(
    (await db.select().from(apiTokens).where(eq(apiTokens.id, bId))).length,
    1,
    "team B's token survived",
  );
});

test("listTokens shows the tokens you minted in your OTHER teams", async () => {
  await alsoMemberOfB(db);
  const id = await asUser1(
    async () => (await createToken({ name: "CI", teamIds: [TEAM_A] })).token.id,
  );
  await asUser1InB(async () => {
    const rows = await listTokens();
    assert.deepEqual(
      rows.map((r) => r.id),
      [id],
    );
  });
});

test("you can revoke your own token from a team it never reached", async () => {
  await alsoMemberOfB(db);
  const id = await asUser1(
    async () => (await createToken({ name: "CI", teamIds: [TEAM_A] })).token.id,
  );
  await asUser1InB(() => revokeToken(id));
  assert.equal(
    (await db.select().from(apiTokens)).length,
    0,
    "revoking your own credential from outside its reach cuts the whole thing",
  );
});

test("listTokens is scoped to the active team", async () => {
  await pg.exec(TRUNCATE);
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      { id: "user_2", teamId: TEAM_B, role: "owner" },
    ],
  });

  await runWithIdentity({ userId: "user_2", teamId: TEAM_B }, async () => {
    await createToken({ name: "B-token" });
  });
  await asUser1(async () => {
    assert.equal(
      (await listTokens()).length,
      0,
      "user_1 sees no team-B tokens",
    );
    await createToken({ name: "A-token" });
    assert.equal((await listTokens()).length, 1);
  });
});

test("someone else's token is not found, whatever you administer", async () => {
  await pg.exec(TRUNCATE);
  await seedIdentity(db, {
    users: [
      { id: "u_creator", teamId: TEAM_A, role: "owner" },
      { id: "u_editor", teamId: TEAM_A, role: "owner" },
    ],
  });
  await seedMembership(db, "u_creator", TEAM_B, [...ALL_CAPABILITIES]);
  await seedMembership(db, "u_editor", TEAM_B, [...ALL_CAPABILITIES]);

  await runWithIdentity({ userId: "u_creator", teamId: TEAM_A }, () =>
    createToken({ name: "ci", capabilities: ["view", "delete_apps"] }),
  );
  const tokenId = (await db.select().from(apiTokens))[0]!.id;

  await runWithIdentity({ userId: "u_editor", teamId: TEAM_A }, async () => {
    assert.deepEqual(await listTokens(), []);
    await assert.rejects(
      () => updateToken({ id: tokenId, name: "ci", capabilities: ["view"] }),
      /Token not found/,
    );
    await assert.rejects(() => revokeToken(tokenId), /Token not found/);
  });
  assert.equal((await db.select().from(apiTokens)).length, 1);
});

test("an instance admin can't see or revoke another person's token either", async () => {
  await pg.exec(TRUNCATE);
  await seedIdentity(db, {
    users: [
      { id: "u_creator", teamId: TEAM_A, role: "owner" },
      { id: "u_admin", teamId: TEAM_A, role: "owner" },
    ],
  });
  await pg.exec(
    `update users set is_instance_admin = true where id = 'u_admin'`,
  );
  await runWithIdentity({ userId: "u_creator", teamId: TEAM_A }, () =>
    createToken({ name: "ci", capabilities: ["view"] }),
  );
  const tokenId = (await db.select().from(apiTokens))[0]!.id;
  await runWithIdentity({ userId: "u_admin", teamId: TEAM_A }, async () => {
    assert.deepEqual(await listTokens(), []);
    await assert.rejects(() => revokeToken(tokenId), /Token not found/);
  });
});

test("a member sees only their own tokens, and revokes only their own", async () => {
  await pg.exec(TRUNCATE);
  await seedIdentity(db, {
    users: [
      { id: "u_one", teamId: TEAM_A, role: "owner" },
      { id: "u_two", teamId: TEAM_A, role: "owner" },
    ],
  });
  const one = await runWithIdentity({ userId: "u_one", teamId: TEAM_A }, () =>
    createToken({ name: "one", capabilities: ["view"] }),
  );
  const two = await runWithIdentity({ userId: "u_two", teamId: TEAM_A }, () =>
    createToken({ name: "two", capabilities: ["view"] }),
  );
  await runWithIdentity({ userId: "u_two", teamId: TEAM_A }, async () => {
    assert.deepEqual(
      (await listTokens()).map((t) => t.id),
      [two.token.id],
    );
    await assert.rejects(() => revokeToken(one.token.id), /Token not found/);
    await revokeToken(two.token.id);
  });
  assert.deepEqual(
    (await db.select().from(apiTokens)).map((t) => t.id),
    [one.token.id],
  );
});
