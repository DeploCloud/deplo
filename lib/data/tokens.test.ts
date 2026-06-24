import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { apiTokens } from "../db/schema/control-plane";
import { runWithIdentity } from "../auth/request-context";
import { seedIdentity, TEAM_A, TEAM_B, USER_1 } from "./leaf-test-helpers";
import {
  authenticateToken,
  createToken,
  listTokens,
  revokeToken,
} from "./tokens";

/**
 * Data-layer tests for the `api_tokens` leaf collection against pglite
 * (relational-store PLAN Step 2). Drives the LIVE async functions (now backed by
 * Drizzle) under a `runWithIdentity` principal, with identity seeded in the JSONB
 * store and the FK roots seeded in pglite (see `leaf-test-helpers`).
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
  await pg.exec(`truncate table api_tokens, users, teams restart identity cascade;`);
  await seedIdentity(db);
});

const asUser1 = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);

test("createToken returns the raw once and listTokens shows it (no secret)", async () => {
  await asUser1(async () => {
    const { raw, token } = await createToken("CI");
    assert.ok(raw.startsWith("deplo_"), "raw token is a deplo_ token");
    assert.equal(token.name, "CI");
    assert.equal(token.lastUsedAt, null);

    const list = await listTokens();
    assert.equal(list.length, 1);
    assert.equal(list[0]!.id, token.id);
    assert.equal(list[0]!.prefix, raw.slice(0, 12));
    // The DTO never carries the hash.
    assert.equal("tokenHash" in list[0]!, false);
  });

  // The hash IS persisted (only the hash, never the raw).
  const rows = await db.select().from(apiTokens);
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0]!.tokenHash, "");
});

test("createToken rejects a blank name", async () => {
  await asUser1(async () => {
    await assert.rejects(() => createToken("   "), /Name is required/);
  });
});

test("authenticateToken resolves a created token's principal and bumps lastUsedAt", async () => {
  const raw = await asUser1(async () => (await createToken("CI")).raw);

  const identity = await authenticateToken(raw);
  assert.deepEqual(identity, { userId: USER_1, teamId: TEAM_A });

  // lastUsedAt is stamped (fire-and-forget update); poll briefly since it's not awaited.
  let stamped: string | null = null;
  for (let i = 0; i < 50 && stamped === null; i++) {
    const rows = await db.select().from(apiTokens).limit(1);
    stamped = rows[0]!.lastUsedAt;
    if (stamped === null) await new Promise((r) => setTimeout(r, 10));
  }
  assert.ok(stamped, "lastUsedAt was stamped after authentication");
});

test("authenticateToken returns null for an unknown or non-deplo token", async () => {
  assert.equal(await authenticateToken("not-a-deplo-token"), null);
  assert.equal(await authenticateToken("deplo_doesnotexist"), null);
});

test("revokeToken removes only the active team's matching token", async () => {
  const id = await asUser1(async () => (await createToken("CI")).token.id);
  await asUser1(async () => {
    await revokeToken(id);
    assert.equal((await listTokens()).length, 0);
  });
  assert.equal((await db.select().from(apiTokens).where(eq(apiTokens.id, id))).length, 0);
});

test("listTokens is scoped to the active team", async () => {
  // Seed a second user/owner in team B and a token there; user_1 must not see it.
  await pg.exec(`truncate table api_tokens, users, teams restart identity cascade;`);
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      { id: "user_2", teamId: TEAM_B, role: "owner" },
    ],
  });

  await runWithIdentity({ userId: "user_2", teamId: TEAM_B }, async () => {
    await createToken("B-token");
  });
  await asUser1(async () => {
    assert.equal((await listTokens()).length, 0, "user_1 sees no team-B tokens");
    await createToken("A-token");
    assert.equal((await listTokens()).length, 1);
  });
});
