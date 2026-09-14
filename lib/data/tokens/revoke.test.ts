import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { makeTestDb, type TestDb } from "../../db/test-harness";
import { __setTestDb, __resetTestDb } from "../../db/client";
import {
  apiTokens,
  apiTokenProjects,
  apiTokenTeams,
} from "../../db/schema/control-plane/api-tokens";
import { seedIdentity, TEAM_A, TEAM_B } from "../leaf-test-helpers";
import { authenticateToken } from "./authenticate";
import { listTokens } from "./listing";
import { createToken } from "./mint";
import { revokeToken } from "./revoke";
import {
  TRUNCATE,
  asUser1,
  asUser1InB,
  alsoMemberOfB,
  seedProject,
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

test("revokeToken deletes the row", async () => {
  const id = await asUser1(
    async () => (await createToken({ name: "CI" })).token.id,
  );
  await asUser1(async () => {
    await revokeToken(id);
    assert.equal((await listTokens()).length, 0);
  });
  assert.equal(
    (await db.select().from(apiTokens).where(eq(apiTokens.id, id))).length,
    0,
  );
});

test("revoking a token scoped to this team alone deletes it", async () => {
  const id = await asUser1(
    async () => (await createToken({ name: "CI", teamIds: [TEAM_A] })).token.id,
  );
  await asUser1(() => revokeToken(id));
  assert.equal(
    (await db.select().from(apiTokens).where(eq(apiTokens.id, id))).length,
    0,
    "the last team to let go deletes the row",
  );
});

test("revoking from one team ends the token in every team it reached", async () => {
  await alsoMemberOfB(db);
  const raw = await asUser1(
    async () =>
      (await createToken({ name: "CI", teamIds: [TEAM_A, TEAM_B] })).raw,
  );
  const id = (await db.select().from(apiTokens))[0]!.id;

  await asUser1InB(() => revokeToken(id));

  assert.equal(
    (await db.select().from(apiTokens).where(eq(apiTokens.id, id))).length,
    0,
    "revoke deletes the credential, it does not detach one team from it",
  );
  assert.equal(
    (await db.select().from(apiTokenTeams).where(eq(apiTokenTeams.tokenId, id)))
      .length,
    0,
  );
  assert.equal(await authenticateToken(raw, TEAM_A), null);
});

test("every team that lost the credential gets the trail entry", async () => {
  await alsoMemberOfB(db);
  const id = await asUser1(
    async () =>
      (await createToken({ name: "CI", teamIds: [TEAM_A, TEAM_B] })).token.id,
  );
  await asUser1InB(() => revokeToken(id));

  for (const teamId of [TEAM_A, TEAM_B]) {
    const rows = (
      await pg.query(
        `select message from activities where team_id = $1 and message like 'Revoked%'`,
        [teamId],
      )
    ).rows as { message: string }[];
    assert.deepEqual(
      rows.map((r) => r.message),
      ["Revoked the CI API token"],
      `team ${teamId} was not told`,
    );
  }
});

test("a team reached only through a project may revoke the whole token", async () => {
  await alsoMemberOfB(db);
  await seedProject(db, "prc_b", TEAM_B, "Beta");
  const id = await asUser1(
    async () =>
      (
        await createToken({
          name: "CI",
          teamIds: [TEAM_A],
          projectIds: ["prc_b"],
        })
      ).token.id,
  );

  await asUser1InB(() => revokeToken(id));

  assert.equal(
    (await db.select().from(apiTokens).where(eq(apiTokens.id, id))).length,
    0,
    "the project row is what reached team B, and it is a full revoke lever",
  );
  assert.equal(
    (
      await db
        .select()
        .from(apiTokenProjects)
        .where(eq(apiTokenProjects.tokenId, id))
    ).length,
    0,
    "the junction rows go with the row",
  );
});

test("an unscoped token is revoked outright too", async () => {
  await alsoMemberOfB(db);
  const id = await asUser1(
    async () => (await createToken({ name: "CI" })).token.id,
  );
  await asUser1InB(() => revokeToken(id));
  assert.equal(
    (await db.select().from(apiTokens).where(eq(apiTokens.id, id))).length,
    0,
  );
});
