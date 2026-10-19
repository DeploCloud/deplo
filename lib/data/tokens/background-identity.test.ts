import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { makeTestDb, type TestDb } from "../../db/test-harness";
import { __setTestDb, __resetTestDb } from "../../db/client";
import { apiTokens } from "../../db/schema/control-plane/api-tokens";
import { seedIdentity, TEAM_A, USER_1 } from "../leaf-test-helpers";
import { identityForTokenId } from "./authenticate";
import { createToken } from "./mint";
import { TRUNCATE, asUser1 } from "./tokens-test-helpers";

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

test("a background job rebuilt from a token keeps the token's capabilities, not its owner's", async () => {
  const { token } = await asUser1(() =>
    createToken({ name: "Narrow", capabilities: ["create_projects"] }),
  );
  const identity = await identityForTokenId(token.id, TEAM_A);
  assert.equal(identity?.userId, USER_1);
  assert.equal(identity?.teamId, TEAM_A);
  const caps = identity?.token?.capabilities ?? [];
  assert.ok(caps.includes("create_projects"));
  assert.ok(
    !caps.includes("delete_apps"),
    "the owner's other capabilities stay out",
  );
  assert.equal(identity?.token?.instanceAdmin, false);
});

test("an expired token, an unknown one or another team resolves to nothing", async () => {
  const { token } = await asUser1(() =>
    createToken({ name: "Soon gone", capabilities: ["create_projects"] }),
  );
  assert.equal(await identityForTokenId(token.id, "team_elsewhere"), null);
  assert.equal(await identityForTokenId("tok_missing", TEAM_A), null);
  await db
    .update(apiTokens)
    .set({ expiresAt: new Date(Date.now() - 1000).toISOString() })
    .where(eq(apiTokens.id, token.id));
  assert.equal(await identityForTokenId(token.id, TEAM_A), null);
});
