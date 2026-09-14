import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { makeTestDb, type TestDb } from "../../db/test-harness";
import { __setTestDb, __resetTestDb } from "../../db/client";
import { apiTokens } from "../../db/schema/control-plane/api-tokens";
import { teams as teamsTable } from "../../db/schema/control-plane/identity";
import { projects as projectsTable } from "../../db/schema/control-plane/projects";
import { oauthClient } from "../../db/schema/auth";
import { seedIdentity, TEAM_A, USER_1 } from "../leaf-test-helpers";
import { authenticateToken } from "./authenticate";
import { createToken } from "./mint";
import { TRUNCATE, asUser1, seedProject } from "./tokens-test-helpers";

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

test("authenticateToken returns the token's own grant and bumps lastUsedAt", async () => {
  const { raw, id } = await asUser1(async () => {
    const r = await createToken({
      name: "CI",
      capabilities: ["deploy_apps"],
    });
    return { raw: r.raw, id: r.token.id };
  });

  const identity = await authenticateToken(raw);
  assert.deepEqual(identity, {
    userId: USER_1,
    teamId: TEAM_A,
    token: {
      id,
      capabilities: ["view", "deploy_apps"],
      scope: null,
      instanceAdmin: false,
    },
  });

  let stamped: string | null = null;
  for (let i = 0; i < 50 && stamped === null; i++) {
    const rows = await db.select().from(apiTokens).limit(1);
    stamped = rows[0]!.lastUsedAt;
    if (stamped === null) await new Promise((r) => setTimeout(r, 10));
  }
  assert.ok(stamped, "lastUsedAt was stamped after authentication");
});

test("a scope whose every node was deleted stops resolving, it does not widen", async () => {
  await seedProject(db, "prc_a", TEAM_A, "Alpha");
  const raw = await asUser1(
    async () =>
      (
        await createToken({
          name: "Scoped",
          capabilities: ["deploy_apps"],
          projectIds: ["prc_a"],
        })
      ).raw,
  );
  // The FK cascades the junction row away; without `scoped` on the token itself this is exactly
  // where it would silently widen to the whole team.
  await db.delete(projectsTable).where(eq(projectsTable.id, "prc_a"));

  // Fail closed: its team set is DERIVED from the nodes it named, and a 401 is far easier to debug
  // than a token that authenticates and then finds nothing anywhere.
  assert.equal(await authenticateToken(raw), null);
});

test("authenticateToken returns null for an unknown or non-deplo token", async () => {
  assert.equal(await authenticateToken("not-a-deplo-token"), null);
  assert.equal(await authenticateToken("deplo_doesnotexist"), null);
});

test("an MCP connection's token stops resolving in a team that turned MCP off", async () => {
  const t = await asUser1(() =>
    createToken({ name: "claude", capabilities: ["view"] }),
  );
  await db.insert(oauthClient).values({
    id: "oac_claude",
    clientId: "cli_claude",
    name: "Claude",
    redirectUris: [],
  });
  await db
    .update(apiTokens)
    .set({ oauthClientId: "cli_claude" })
    .where(eq(apiTokens.id, t.token.id));
  assert.ok(await authenticateToken(t.raw), "resolves while MCP is on");
  await db
    .update(teamsTable)
    .set({ mcpEnabled: false })
    .where(eq(teamsTable.id, TEAM_A));
  assert.equal(await authenticateToken(t.raw), null);
  const plain = await asUser1(() =>
    createToken({ name: "ci", capabilities: ["view"] }),
  );
  assert.ok(await authenticateToken(plain.raw));
});
