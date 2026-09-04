import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import {
  apiTokens,
  apiTokenCapabilities,
  apiTokenProjects,
  apiTokenTeams,
  memberships,
  membershipCapabilities,
  projects as projectsTable,
} from "../db/schema/control-plane";
import { runWithIdentity } from "../auth/request-context";
import { seedIdentity, TEAM_A, TEAM_B, USER_1 } from "./leaf-test-helpers";
import { ALL_CAPABILITIES, type Capability } from "../types";
import {
  authenticateToken,
  createToken,
  listTokens,
  tokenCountsByUser,
  updateToken,
  revokeToken,
} from "./tokens";
import { listActivity } from "./activity";

/**
 * Data-layer tests for the `api_tokens` leaf collection against pglite
 * (relational-store PLAN Step 2).
 */

let db: TestDb;
let pg: PGlite;

const T0 = "2026-01-01T00:00:00.000Z";
const TRUNCATE = `truncate table api_tokens, projects, activities, users, teams restart identity cascade;`;

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

const asUser1 = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);

/** The same person, acting in the other team - what a partial revoke needs. */
const asUser1InB = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_B }, fn);

async function alsoMemberOfB(): Promise<void> {
  await db.insert(memberships).values({
    id: "mem_user_1_b",
    userId: USER_1,
    teamId: TEAM_B,
    role: "owner",
    createdAt: T0,
  });
  await db.insert(membershipCapabilities).values(
    ALL_CAPABILITIES.map((c) => ({
      membershipId: "mem_user_1_b",
      capability: c,
    })),
  );
}

async function seedProject(id: string, teamId: string, name = id) {
  await db.insert(projectsTable).values({
    id,
    teamId,
    name,
    slug: name.toLowerCase(),
    createdAt: T0,
    updatedAt: T0,
  });
}

test("a scoped API token can't mint a token reaching a team outside its scope (M-2)", async () => {
  await alsoMemberOfB(); // USER_1 owns both TEAM_A and TEAM_B
  const asScopedToken = <T>(
    scopeTeamIds: string[],
    fn: () => Promise<T>,
  ): Promise<T> =>
    runWithIdentity(
      {
        userId: USER_1,
        teamId: TEAM_A,
        token: {
          id: "tok_actor",
          capabilities: ["view", "manage_tokens"] as Capability[],
          instanceAdmin: false,
          scope: {
            teamIds: scopeTeamIds,
            wholeTeamIds: scopeTeamIds,
            projectIds: [],
            folderIds: [],
            appIds: [],
            appProjectIds: [],
          },
        },
      },
      fn,
    );

  await asScopedToken([TEAM_A], async () => {
    // Reaching TEAM_B is outside the token's own scope, even though its human is
    // an owner there - the clamp bounds capabilities, this bounds reach.
    await assert.rejects(
      () =>
        createToken({
          name: "into-B",
          capabilities: ["view"],
          teamIds: [TEAM_B],
        }),
      /outside its own scope/i,
    );
    // An UNSCOPED token would reach every team the human belongs to.
    await assert.rejects(
      () => createToken({ name: "unscoped", capabilities: ["view"] }),
      /can't mint an unscoped token/i,
    );
  });

  // A cookie session mints freely, and a token scoped to BOTH teams still can.
  const cookie = await asUser1(() =>
    createToken({ name: "cookie", capabilities: ["view"], teamIds: [TEAM_B] }),
  );
  assert.ok(cookie.raw.startsWith("deplo_"));
  await asScopedToken([TEAM_A, TEAM_B], async () => {
    const ok = await createToken({
      name: "both",
      capabilities: ["view"],
      teamIds: [TEAM_B],
    });
    assert.ok(ok.raw.startsWith("deplo_"));
  });
});

test("createToken persists its own capability set, in catalog order, with the view floor", async () => {
  await asUser1(async () => {
    const { raw, token } = await createToken({
      name: "CI",
      capabilities: ["view_logs", "deploy_apps"],
    });
    assert.ok(raw.startsWith("deplo_"), "raw token is a deplo_ token");
    assert.equal(token.name, "CI");
    assert.equal(token.lastUsedAt, null);
    assert.deepEqual(token.capabilities, ["view", "deploy_apps", "view_logs"]);

    const list = await listTokens();
    assert.equal(list.length, 1);
    assert.equal(list[0]!.id, token.id);
    assert.equal(list[0]!.prefix, raw.slice(0, 12));
    assert.deepEqual(list[0]!.capabilities, [
      "view",
      "deploy_apps",
      "view_logs",
    ]);
    assert.equal(list[0]!.scoped, false);
    assert.deepEqual(list[0]!.teamIds, []);
    assert.deepEqual(list[0]!.projectIds, []);
    assert.deepEqual(list[0]!.appIds, []);
    // The DTO never carries the hash.
    assert.equal("tokenHash" in list[0]!, false);
  });

  // The hash IS persisted (only the hash, never the raw).
  const rows = await db.select().from(apiTokens);
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0]!.tokenHash, "");
});

test("a token with no capabilities named is view-only, never everything", async () => {
  await asUser1(async () => {
    const { token } = await createToken({ name: "Bare" });
    assert.deepEqual(token.capabilities, ["view"]);
  });
});

test("createToken rejects a blank name", async () => {
  await asUser1(async () => {
    await assert.rejects(
      () => createToken({ name: "   " }),
      /Give the token a name/,
    );
  });
});

test("a non-owner can't mint a token more powerful than themselves", async () => {
  await pg.exec(TRUNCATE);
  await seedIdentity(db, {
    users: [
      {
        id: USER_1,
        teamId: TEAM_A,
        role: "member",
        capabilities: ["view", "manage_tokens", "deploy_apps"],
      },
    ],
  });
  await asUser1(async () => {
    await assert.rejects(
      () => createToken({ name: "Escalate", capabilities: ["delete_apps"] }),
      /only give a token permissions you hold yourself[\s\S]*delete apps/,
    );
    // What they DO hold still goes through.
    const { token } = await createToken({
      name: "Fine",
      capabilities: ["deploy_apps"],
    });
    assert.deepEqual(token.capabilities, ["view", "deploy_apps"]);
  });
});

test("an owner can mint Root access", async () => {
  await asUser1(async () => {
    const { token } = await createToken({
      name: "Root",
      capabilities: [...ALL_CAPABILITIES],
    });
    assert.deepEqual(token.capabilities, ALL_CAPABILITIES);
  });
});

test("a retired coarse capability name still expands on the token path", async () => {
  await asUser1(async () => {
    const { token } = await createToken({
      name: "Legacy",
      // `deploy` was one of the original eight; an old API client still sends it.
      capabilities: ["deploy" as never],
    });
    assert.ok(token.capabilities.includes("deploy_apps"));
    assert.ok(
      token.capabilities.length > 2,
      "it expanded to more than the floor",
    );
  });
});

test("a project scope round-trips, and a foreign project writes nothing", async () => {
  await seedProject("prc_a", TEAM_A, "Alpha");
  await seedProject("prc_b", TEAM_B, "Beta");
  await asUser1(async () => {
    const { token } = await createToken({
      name: "Scoped",
      capabilities: ["deploy_apps"],
      projectIds: ["prc_a"],
    });
    assert.equal(token.scoped, true);
    assert.deepEqual(token.projectIds, ["prc_a"]);

    await assert.rejects(
      () =>
        createToken({
          name: "Foreign",
          projectIds: ["prc_b"],
        }),
      /isn't in a team you can use API tokens in/,
    );
  });
  // The refusal rolled the whole insert back, no half-created token.
  assert.equal((await db.select().from(apiTokens)).length, 1);
  assert.equal((await db.select().from(apiTokenProjects)).length, 1);
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

  // lastUsedAt is stamped (fire-and-forget update); poll briefly since it's not awaited.
  let stamped: string | null = null;
  for (let i = 0; i < 50 && stamped === null; i++) {
    const rows = await db.select().from(apiTokens).limit(1);
    stamped = rows[0]!.lastUsedAt;
    if (stamped === null) await new Promise((r) => setTimeout(r, 10));
  }
  assert.ok(stamped, "lastUsedAt was stamped after authentication");
});

test("a scope whose every node was deleted stops resolving, it does not widen", async () => {
  await seedProject("prc_a", TEAM_A, "Alpha");
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
  // The FK cascades the junction row away. Without `scoped` on the token
  // itself, this is exactly where the token would silently widen to the team.
  await db.delete(projectsTable).where(eq(projectsTable.id, "prc_a"));

  // It stops resolving entirely rather than reading as "unscoped" and widening:
  // its team set is DERIVED from the nodes it named, and there are none left, so
  // there is no team it may act in. Fail closed, and a 401 is a far easier thing
  // to debug than a token that authenticates and then finds nothing anywhere.
  assert.equal(await authenticateToken(raw), null);
});

test("authenticateToken returns null for an unknown or non-deplo token", async () => {
  assert.equal(await authenticateToken("not-a-deplo-token"), null);
  assert.equal(await authenticateToken("deplo_doesnotexist"), null);
});

test("instance admin is opt-in per token, and only an instance admin may grant it", async () => {
  await asUser1(async () => {
    const { token } = await createToken({ name: "Ops", instanceAdmin: true });
    assert.equal(token.instanceAdmin, true);
    await assert.rejects(
      () =>
        createToken({
          name: "Contradiction",
          instanceAdmin: true,
          projectIds: ["prc_a"],
        }),
      /can't administer the instance/,
    );
  });

  // A plain manage_tokens holder who is NOT an instance admin cannot.
  await pg.exec(TRUNCATE);
  await seedIdentity(db, {
    users: [
      {
        id: USER_1,
        teamId: TEAM_A,
        role: "member",
        capabilities: ["view", "manage_tokens"],
      },
    ],
  });
  await asUser1(async () => {
    await assert.rejects(
      () => createToken({ name: "Sneaky", instanceAdmin: true }),
      /Only an instance admin/,
    );
  });
});

test("a non-admin can't edit a token that administers the instance", async () => {
  const id = await asUser1(
    async () =>
      (await createToken({ name: "Ops", instanceAdmin: true })).token.id,
  );
  // Demote the actor to a plain manage_tokens holder, leaving the token in place.
  await pg.exec(`delete from membership_capabilities;`);
  await db.execute(
    `insert into membership_capabilities (membership_id, capability) values ('mem_${USER_1}', 'view'), ('mem_${USER_1}', 'manage_tokens')`,
  );
  await db.execute(
    `update users set is_instance_admin = false where id = '${USER_1}'`,
  );

  await asUser1(async () => {
    await assert.rejects(
      () => updateToken({ id, name: "Hijacked", capabilities: ["view"] }),
      /Only an instance admin/,
    );
  });
  const rows = await db.select().from(apiTokens).where(eq(apiTokens.id, id));
  assert.equal(
    rows[0]!.instanceAdmin,
    true,
    "the bit was not silently cleared",
  );
  assert.equal(rows[0]!.name, "Ops");
});

test("updateToken rewrites both junctions rather than merging into them", async () => {
  await seedProject("prc_a", TEAM_A, "Alpha");
  const id = await asUser1(
    async () =>
      (
        await createToken({
          name: "Scoped",
          capabilities: ["deploy_apps", "view_logs"],
          projectIds: ["prc_a"],
        })
      ).token.id,
  );
  await asUser1(async () => {
    await updateToken({ id, name: "Narrowed", capabilities: ["view_logs"] });
    const t = (await listTokens())[0]!;
    assert.equal(t.name, "Narrowed");
    assert.deepEqual(t.capabilities, ["view", "view_logs"]);
    assert.equal(t.scoped, false);
    assert.deepEqual(t.projectIds, []);
  });
  assert.equal(
    (await db.select().from(apiTokenCapabilities)).length,
    2,
    "the old capability rows are gone, not merged",
  );
  assert.equal((await db.select().from(apiTokenProjects)).length, 0);
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
  await alsoMemberOfB();
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
  // Dead everywhere, including the team that never pressed the button.
  assert.equal(await authenticateToken(raw, TEAM_A), null);
});

test("every team that lost the credential gets the trail entry", async () => {
  await alsoMemberOfB();
  const id = await asUser1(
    async () =>
      (await createToken({ name: "CI", teamIds: [TEAM_A, TEAM_B] })).token.id,
  );
  // Team A loses an automation it did not switch off: reading that as a line in
  // Activity, with a name on it, is the only alternative to reading it as an
  // outage.
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
  await alsoMemberOfB();
  await seedProject("prc_b", TEAM_B, "Beta");
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
  await alsoMemberOfB();
  const id = await asUser1(
    async () => (await createToken({ name: "CI" })).token.id,
  );
  await asUser1InB(() => revokeToken(id));
  assert.equal(
    (await db.select().from(apiTokens).where(eq(apiTokens.id, id))).length,
    0,
  );
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
  await alsoMemberOfB();
  const id = await asUser1(
    async () => (await createToken({ name: "CI", teamIds: [TEAM_A] })).token.id,
  );
  // Settings → API tokens is an account page with no team switcher on it, so a
  // token the active team filters out is one you cannot reach at all.
  await asUser1InB(async () => {
    const rows = await listTokens();
    assert.deepEqual(
      rows.map((r) => r.id),
      [id],
    );
  });
});

test("you can revoke your own token from a team it never reached", async () => {
  await alsoMemberOfB();
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

/* ------------------------------------------------------------------ */
/* Re-authoring SOMEONE ELSE's token                                    */
/* ------------------------------------------------------------------ */

/**
 * A token's live clamp measures it against its CREATOR, so it says nothing about
 * whoever edits it afterwards. Editing is allowed from the team the token was
 * created in, but a token's reach can span teams, and being an administrator in
 * the home team is not authority in the others.
 */

/** Give `userId` a membership in `teamId` with exactly `caps`. */
async function seedMembership(
  userId: string,
  teamId: string,
  caps: Capability[],
): Promise<void> {
  const id = `mem_${userId}_${teamId}`;
  await db
    .insert(memberships)
    .values({ id, userId, teamId, role: "member", createdAt: T0 });
  await db
    .insert(membershipCapabilities)
    .values(caps.map((capability) => ({ membershipId: id, capability })));
}

test("someone else's token is not found, whatever you administer", async () => {
  await pg.exec(TRUNCATE);
  await seedIdentity(db, {
    users: [
      { id: "u_creator", teamId: TEAM_A, role: "owner" },
      { id: "u_editor", teamId: TEAM_A, role: "owner" },
    ],
  });
  await seedMembership("u_creator", TEAM_B, [...ALL_CAPABILITIES]);
  await seedMembership("u_editor", TEAM_B, [...ALL_CAPABILITIES]);

  await runWithIdentity({ userId: "u_creator", teamId: TEAM_A }, () =>
    createToken({ name: "ci", capabilities: ["view", "delete_apps"] }),
  );
  const tokenId = (await db.select().from(apiTokens))[0]!.id;

  // An owner of every team the token reaches: still not theirs to see, edit
  // or revoke. The lever a team has is the member, never the credential.
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

test("a token reaches only the teams where its owner may use API tokens", async () => {
  await pg.exec(TRUNCATE);
  await seedIdentity(db, {
    users: [{ id: "u_creator", teamId: TEAM_A, role: "owner" }],
  });
  // In B without `manage_tokens`: a member, but not one whose tokens act there.
  await seedMembership("u_creator", TEAM_B, ["view", "deploy_apps"]);
  const { raw, token } = await runWithIdentity(
    { userId: "u_creator", teamId: TEAM_A },
    () => createToken({ name: "ci", capabilities: ["view", "deploy_apps"] }),
  );
  assert.deepEqual(
    token.teamsReached.map((t) => t.id),
    [TEAM_A],
    "the DTO names only the teams the token can act in",
  );
  // Asked for B, resolved in A: B is out of reach, not a choice.
  assert.equal((await authenticateToken(raw, TEAM_B))?.teamId, TEAM_A);
  assert.equal((await tokenCountsByUser(TEAM_B)).get("u_creator"), undefined);

  // Granting the permission is what lets the SAME token in - nothing on the
  // token changes.
  await db.insert(membershipCapabilities).values({
    membershipId: `mem_u_creator_${TEAM_B}`,
    capability: "manage_tokens",
  });
  assert.equal((await authenticateToken(raw, TEAM_B))?.teamId, TEAM_B);
  assert.equal((await tokenCountsByUser(TEAM_B)).get("u_creator")?.tokens, 1);

  // And losing it in the LAST team stops the token resolving at all.
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
  await seedMembership("u_creator", TEAM_B, ["view", "deploy_apps"]);
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
  // No team lets their tokens in, so there is nothing to mint.
  await runWithIdentity({ userId: "u_viewer", teamId: TEAM_A }, () =>
    assert.rejects(
      () => createToken({ name: "nothing", capabilities: ["view"] }),
      /can't use API tokens in any of your teams/,
    ),
  );
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

test("the trail lands in every team the token reaches, and counts per member", async () => {
  await pg.exec(TRUNCATE);
  await seedIdentity(db, {
    users: [{ id: "u_creator", teamId: TEAM_A, role: "owner" }],
  });
  await seedMembership("u_creator", TEAM_B, [
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
  await seedMembership("u_creator", TEAM_B, ["view", "manage_tokens"]);

  const { raw } = await runWithIdentity(
    { userId: "u_creator", teamId: TEAM_A },
    () => createToken({ name: "ci", capabilities: ["view", "delete_apps"] }),
  );
  const tokenId = (await db.select().from(apiTokens))[0]!.id;
  // Unrestricted, so it reaches team B too - where the creator is read-only. The
  // edit stands, because the live clamp already answers for it there.
  await runWithIdentity({ userId: "u_creator", teamId: TEAM_A }, () =>
    updateToken({
      id: tokenId,
      name: "ci",
      capabilities: ["view", "delete_apps"],
    }),
  );
  const inB = await authenticateToken(raw, TEAM_B);
  const { currentCapabilities } = await import("../membership");
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
  // Everything in A, a narrower set in B: the multi-team shape that used to be
  // unsaveable from B (wrong home team) and from A (the ceiling was the team you
  // stood in, so `delete_apps` would have been refused had they stood in B).
  await seedMembership("u_creator", TEAM_B, [
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

/* ------------------------------------------------------------------ */
/* Expiry                                                              */
/* ------------------------------------------------------------------ */

/**
 * A token used to live until somebody revoked it, and nothing ever made anybody.
 * The expiry is enforced in `identityForTokenRow` - the one place both credential
 * shapes and every entry point (GraphQL, MCP, the deploy hook) resolve through,
 * so it cannot be true in one of them and not another.
 */
test("an expired token authenticates as nothing", async () => {
  const raw = await asUser1(
    async () =>
      (
        await createToken({
          name: "Short-lived",
          capabilities: ["deploy_apps"],
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        })
      ).raw,
  );
  assert.ok(await authenticateToken(raw), "valid while it lasts");

  // Move the expiry into the past rather than sleeping.
  await db
    .update(apiTokens)
    .set({ expiresAt: new Date(Date.now() - 1000).toISOString() })
    .where(eq(apiTokens.name, "Short-lived"));
  assert.equal(await authenticateToken(raw), null, "refused once past");
});

test("createToken refuses an expiry that has already passed", async () => {
  await asUser1(async () => {
    await assert.rejects(
      createToken({
        name: "Born dead",
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      }),
      /future/,
    );
    await assert.rejects(
      createToken({ name: "Nonsense", expiresAt: "not-a-date" }),
      /not a date/,
    );
  });
});

test("no expiry is the default, and it stays null", async () => {
  const { token } = await asUser1(() => createToken({ name: "Forever" }));
  assert.equal(token.expiresAt, null);
  const rows = await db
    .select()
    .from(apiTokens)
    .where(eq(apiTokens.name, "Forever"));
  assert.equal(rows[0]!.expiresAt, null);
});
