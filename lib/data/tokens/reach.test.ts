import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { makeTestDb, type TestDb } from "../../db/test-harness";
import { __setTestDb, __resetTestDb } from "../../db/client";
import { membershipCapabilities } from "../../db/schema/control-plane/access-control";
import { apiTokens } from "../../db/schema/control-plane/api-tokens";
import { runWithIdentity } from "../../auth/request-context";
import { seedIdentity, TEAM_A, TEAM_B } from "../leaf-test-helpers";
import { listActivity } from "../activity";
import { authenticateToken } from "./authenticate";
import { createToken, updateToken } from "./mint";
import { tokenCountsByUser } from "./reach";
import { revokeToken } from "./revoke";
import { TRUNCATE, seedMembership } from "./tokens-test-helpers";

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

test("a token reaches only the teams where its owner may use API tokens", async () => {
  await pg.exec(TRUNCATE);
  await seedIdentity(db, {
    users: [{ id: "u_creator", teamId: TEAM_A, role: "owner" }],
  });
  await seedMembership(db, "u_creator", TEAM_B, ["view", "deploy_apps"]);
  const { raw, token } = await runWithIdentity(
    { userId: "u_creator", teamId: TEAM_A },
    () => createToken({ name: "ci", capabilities: ["view", "deploy_apps"] }),
  );
  assert.deepEqual(
    token.teamsReached.map((t) => t.id),
    [TEAM_A],
    "the DTO names only the teams the token can act in",
  );
  assert.equal((await authenticateToken(raw, TEAM_B))?.teamId, TEAM_A);
  assert.equal((await tokenCountsByUser(TEAM_B)).get("u_creator"), undefined);

  await db.insert(membershipCapabilities).values({
    membershipId: `mem_u_creator_${TEAM_B}`,
    capability: "manage_tokens",
  });
  assert.equal((await authenticateToken(raw, TEAM_B))?.teamId, TEAM_B);
  assert.equal((await tokenCountsByUser(TEAM_B)).get("u_creator")?.tokens, 1);

  await db
    .delete(membershipCapabilities)
    .where(eq(membershipCapabilities.capability, "manage_tokens"));
  assert.equal(await authenticateToken(raw), null);
});

test("a token can't be scoped to a team where its owner may not use API tokens", async () => {
  await pg.exec(TRUNCATE);
  await seedIdentity(db, {
    users: [{ id: "u_creator", teamId: TEAM_A, role: "owner" }],
  });
  await seedMembership(db, "u_creator", TEAM_B, ["view", "deploy_apps"]);
  await runWithIdentity({ userId: "u_creator", teamId: TEAM_A }, () =>
    assert.rejects(
      () => createToken({ name: "into-B", teamIds: [TEAM_B] }),
      /can't use API tokens in one of those teams/,
    ),
  );
});

test("any member may mint, bounded by what they hold where the token reaches", async () => {
  await pg.exec(TRUNCATE);
  await seedIdentity(db, {
    users: [
      { id: "u_owner", teamId: TEAM_A, role: "owner" },
      {
        id: "u_member",
        teamId: TEAM_A,
        role: "member",
        capabilities: ["view", "deploy_apps", "manage_tokens"],
      },
      {
        id: "u_viewer",
        teamId: TEAM_A,
        role: "member",
        capabilities: ["view"],
      },
    ],
  });
  await runWithIdentity({ userId: "u_member", teamId: TEAM_A }, async () => {
    const { token } = await createToken({
      name: "deploys",
      capabilities: ["deploy_apps"],
    });
    assert.deepEqual(token.capabilities, ["view", "deploy_apps"]);
    await assert.rejects(
      () => createToken({ name: "more", capabilities: ["delete_apps"] }),
      /permissions you hold yourself/i,
    );
  });
  await runWithIdentity({ userId: "u_viewer", teamId: TEAM_A }, () =>
    assert.rejects(
      () => createToken({ name: "nothing", capabilities: ["view"] }),
      /can't use API tokens in any of your teams/,
    ),
  );
});

test("the trail lands in every team the token reaches, and counts per member", async () => {
  await pg.exec(TRUNCATE);
  await seedIdentity(db, {
    users: [{ id: "u_creator", teamId: TEAM_A, role: "owner" }],
  });
  await seedMembership(db, "u_creator", TEAM_B, [
    "view",
    "manage_tokens",
    "view_activity",
  ]);
  const { token } = await runWithIdentity(
    { userId: "u_creator", teamId: TEAM_A },
    () => createToken({ name: "everywhere", capabilities: ["view"] }),
  );
  for (const teamId of [TEAM_A, TEAM_B]) {
    const trail = await runWithIdentity({ userId: "u_creator", teamId }, () =>
      listActivity(),
    );
    assert.ok(
      trail.some((a) => a.message.includes("Created the everywhere API token")),
      `no trail entry in ${teamId}`,
    );
    assert.deepEqual((await tokenCountsByUser(teamId)).get("u_creator"), {
      tokens: 1,
      agents: 0,
    });
  }
  await runWithIdentity({ userId: "u_creator", teamId: TEAM_A }, () =>
    revokeToken(token.id),
  );
  for (const teamId of [TEAM_A, TEAM_B]) {
    const trail = await runWithIdentity({ userId: "u_creator", teamId }, () =>
      listActivity(),
    );
    assert.ok(
      trail.some((a) => a.message.includes("Revoked the everywhere API token")),
      `no revoke entry in ${teamId}`,
    );
  }
});

test("the creator editing their own token is untouched by the cross-team bound", async () => {
  await pg.exec(TRUNCATE);
  await seedIdentity(db, {
    users: [{ id: "u_creator", teamId: TEAM_A, role: "owner" }],
  });
  await seedMembership(db, "u_creator", TEAM_B, ["view", "manage_tokens"]);

  const { raw } = await runWithIdentity(
    { userId: "u_creator", teamId: TEAM_A },
    () => createToken({ name: "ci", capabilities: ["view", "delete_apps"] }),
  );
  const tokenId = (await db.select().from(apiTokens))[0]!.id;
  await runWithIdentity({ userId: "u_creator", teamId: TEAM_A }, () =>
    updateToken({
      id: tokenId,
      name: "ci",
      capabilities: ["view", "delete_apps"],
    }),
  );
  const inB = await authenticateToken(raw, TEAM_B);
  const { currentCapabilities } = await import("../../membership");
  assert.deepEqual(
    await runWithIdentity(inB!, () => currentCapabilities()),
    ["view"],
    "the clamp against the creator is what bounds it in team B",
  );
});

test("the creator edits their own token from any team, not only the one it was minted in", async () => {
  await pg.exec(TRUNCATE);
  await seedIdentity(db, {
    users: [{ id: "u_creator", teamId: TEAM_A, role: "owner" }],
  });
  await seedMembership(db, "u_creator", TEAM_B, [
    "view",
    "manage_tokens",
    "deploy_apps",
  ]);

  const tokenId = await runWithIdentity(
    { userId: "u_creator", teamId: TEAM_A },
    async () =>
      (
        await createToken({
          name: "agent",
          capabilities: ["view", "delete_apps", "deploy_apps"],
          teamIds: [TEAM_A, TEAM_B],
        })
      ).token.id,
  );

  await runWithIdentity({ userId: "u_creator", teamId: TEAM_B }, () =>
    updateToken({
      id: tokenId,
      name: "agent renamed",
      capabilities: ["view", "delete_apps", "deploy_apps"],
      teamIds: [TEAM_A, TEAM_B],
    }),
  );

  const row = (
    await db.select().from(apiTokens).where(eq(apiTokens.id, tokenId))
  )[0];
  assert.equal(row?.name, "agent renamed");
});
