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
  projects as projectsTable,
} from "../db/schema/control-plane";
import { runWithIdentity } from "../auth/request-context";
import { seedIdentity, TEAM_A, TEAM_B, USER_1 } from "./leaf-test-helpers";
import { ALL_CAPABILITIES } from "../types";
import {
  authenticateToken,
  createToken,
  listTokens,
  updateToken,
  revokeToken,
} from "./tokens";

/**
 * Data-layer tests for the `api_tokens` leaf collection against pglite
 * (relational-store PLAN Step 2). Drives the LIVE async functions under a
 * `runWithIdentity` principal, with the FK roots seeded in pglite (see
 * `leaf-test-helpers`).
 *
 * The identity here carries NO `token`, i.e. these run as a cookie session —
 * which is what a member managing tokens in the dashboard is. What a bearer
 * request does with the resulting grant is `token-scope*.test.ts`.
 */

let db: TestDb;
let pg: PGlite;

const T0 = "2026-01-01T00:00:00.000Z";
const TRUNCATE = `truncate table api_tokens, projects, users, teams restart identity cascade;`;

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
    assert.deepEqual(list[0]!.capabilities, ["view", "deploy_apps", "view_logs"]);
    assert.equal(list[0]!.scoped, false);
    assert.deepEqual(list[0]!.teamIds, []);
    assert.deepEqual(list[0]!.projectIds, []);
    assert.deepEqual(list[0]!.appIds, []);
    assert.equal(list[0]!.createdByUsername, USER_1);
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
    await assert.rejects(() => createToken({ name: "   " }), /Give the token a name/);
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
    assert.ok(token.capabilities.length > 2, "it expanded to more than the floor");
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
      /isn't in a team you belong to/,
    );
  });
  // The refusal rolled the whole insert back — no half-created token.
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
    async () => (await createToken({ name: "Ops", instanceAdmin: true })).token.id,
  );
  // Demote the actor to a plain manage_tokens holder, leaving the token in place.
  await pg.exec(`delete from membership_capabilities;`);
  await db.execute(
    `insert into membership_capabilities (membership_id, capability) values ('mem_${USER_1}', 'view'), ('mem_${USER_1}', 'manage_tokens')`,
  );
  await db.execute(`update users set is_instance_admin = false where id = '${USER_1}'`);

  await asUser1(async () => {
    await assert.rejects(
      () => updateToken({ id, name: "Hijacked", capabilities: ["view"] }),
      /Only an instance admin/,
    );
  });
  const rows = await db.select().from(apiTokens).where(eq(apiTokens.id, id));
  assert.equal(rows[0]!.instanceAdmin, true, "the bit was not silently cleared");
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

test("revokeToken removes only the active team's matching token", async () => {
  const id = await asUser1(
    async () => (await createToken({ name: "CI" })).token.id,
  );
  await asUser1(async () => {
    await revokeToken(id);
    assert.equal((await listTokens()).length, 0);
  });
  assert.equal((await db.select().from(apiTokens).where(eq(apiTokens.id, id))).length, 0);
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
    assert.equal((await listTokens()).length, 0, "user_1 sees no team-B tokens");
    await createToken({ name: "A-token" });
    assert.equal((await listTokens()).length, 1);
  });
});
