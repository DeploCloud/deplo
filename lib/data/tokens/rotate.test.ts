import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { makeTestDb, type TestDb } from "../../db/test-harness";
import { __setTestDb, __resetTestDb } from "../../db/client";
import { runWithIdentity } from "../../auth/request-context";
import { apiTokens } from "../../db/schema/control-plane/api-tokens";
import { type Capability } from "../../types/identity";
import { seedIdentity, TEAM_A, TEAM_B, USER_1 } from "../leaf-test-helpers";
import { authenticateToken } from "./authenticate";
import { listTokens } from "./listing";
import { createToken } from "./mint";
import { rotateToken } from "./rotate";
import {
  TRUNCATE,
  asUser1,
  alsoMemberOfB,
  seedProject,
} from "./tokens-test-helpers";

let db: TestDb;
let pg: PGlite;

const DAY = 86_400_000;
const days = (iso: string | null) => (Date.parse(iso!) - Date.now()) / DAY;

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

function asToken<T>(
  id: string,
  fn: () => Promise<T>,
  capabilities: Capability[] = ["view", "manage_tokens"],
): Promise<T> {
  return runWithIdentity(
    {
      userId: USER_1,
      teamId: TEAM_A,
      token: { id, capabilities, instanceAdmin: false, scope: null },
    },
    fn,
  );
}

test("the old secret stops working and the new one keeps the token's permissions and scope", async () => {
  await seedProject(db, "prc_a", TEAM_A, "Alpha");
  const created = await asUser1(() =>
    createToken({
      name: "CI",
      capabilities: ["deploy_apps", "view_logs"],
      projectIds: ["prc_a"],
    }),
  );
  const before = (await authenticateToken(created.raw))!;

  const rotated = await asUser1(() => rotateToken(created.token.id));

  assert.notEqual(rotated.raw, created.raw);
  assert.ok(rotated.raw.startsWith("deplo_"));
  assert.equal(rotated.token.prefix, rotated.raw.slice(0, 12));
  assert.equal(await authenticateToken(created.raw), null, "old secret works");
  const after = (await authenticateToken(rotated.raw))!;
  assert.ok(after, "new secret doesn't authenticate");
  assert.equal(after.token?.id, created.token.id, "it is the same token");
  assert.deepEqual(after.token?.capabilities, before.token?.capabilities);
  assert.deepEqual(after.token?.scope, before.token?.scope);

  const listed = (await asUser1(() => listTokens()))[0]!;
  assert.equal(listed.name, "CI");
  assert.equal(listed.createdAt, created.token.createdAt);
  assert.deepEqual(listed.projectIds, ["prc_a"]);
  assert.equal(listed.prefix, rotated.token.prefix);
  assert.equal(listed.lastUsedAt, null);
});

test("the expiry restarts from the reroll", async () => {
  const { token } = await asUser1(() =>
    createToken({ name: "CI", expiresAt: null }),
  );
  await asUser1(async () => {
    const thirty = await rotateToken(token.id, {
      expiresAt: new Date(Date.now() + 30 * DAY).toISOString(),
    });
    const d = days(thirty.token.expiresAt);
    assert.ok(d > 29 && d < 31, `expected ~30 days, got ${d}`);

    const defaulted = await rotateToken(token.id);
    const n = days(defaulted.token.expiresAt);
    assert.ok(
      n > 89 && n < 91,
      `an omitted expiry should be ~90 days, got ${n}`,
    );

    const never = await rotateToken(token.id, { expiresAt: null });
    assert.equal(never.token.expiresAt, null);

    await assert.rejects(
      () =>
        rotateToken(token.id, {
          expiresAt: new Date(Date.now() - 1000).toISOString(),
        }),
      /future/,
    );
  });
});

test("rerolling an expired token brings it back", async () => {
  const { token } = await asUser1(() => createToken({ name: "Old" }));
  await db
    .update(apiTokens)
    .set({ expiresAt: new Date(Date.now() - 1000).toISOString() })
    .where(eq(apiTokens.id, token.id));

  const rotated = await asUser1(() => rotateToken(token.id));
  assert.equal(rotated.token.expired, false);
  assert.ok(await authenticateToken(rotated.raw), "the rerolled token works");
});

test("a bearer token can't reroll itself past its own expiry", async () => {
  const { token } = await asUser1(() =>
    createToken({
      name: "short",
      capabilities: ["view", "manage_tokens"],
      expiresAt: new Date(Date.now() + DAY).toISOString(),
    }),
  );
  await asToken(token.id, async () => {
    await assert.rejects(
      () => rotateToken(token.id, { expiresAt: null }),
      /expire no later/i,
    );
    await assert.rejects(
      () =>
        rotateToken(token.id, {
          expiresAt: new Date(Date.now() + 2 * DAY).toISOString(),
        }),
      /expire no later/i,
    );
    const ok = await rotateToken(token.id);
    assert.ok(days(ok.token.expiresAt) <= 1, "the default outlived the token");
  });
});

test("a bearer token can reroll only itself", async () => {
  const a = await asUser1(() =>
    createToken({ name: "a", capabilities: ["view", "manage_tokens"] }),
  );
  const b = await asUser1(() => createToken({ name: "b" }));
  await asToken(a.token.id, async () => {
    await assert.rejects(() => rotateToken(b.token.id), /Token not found/);
  });
  assert.ok(await authenticateToken(b.raw), "b's secret was not replaced");
});

test("another user's token is not found", async () => {
  await pg.exec(TRUNCATE);
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      { id: "user_2", teamId: TEAM_B, role: "owner" },
    ],
  });
  const theirs = await runWithIdentity(
    { userId: "user_2", teamId: TEAM_B },
    () => createToken({ name: "B-token" }),
  );
  await asUser1(async () => {
    await assert.rejects(() => rotateToken(theirs.token.id), /Token not found/);
  });
  assert.ok(await authenticateToken(theirs.raw));
});

test("a connected AI client's token is refused, and can't reroll anything", async () => {
  const { raw, token } = await asUser1(() =>
    createToken({ name: "Claude", capabilities: ["view", "manage_tokens"] }),
  );
  await pg.query(
    `insert into oauth_client (id, client_id, name, redirect_uris, created_at)
     values ('oc_x', 'client_x', 'Claude', ARRAY['https://client.test/cb'], now())`,
  );
  await pg.query(
    `update api_tokens set oauth_client_id = 'client_x' where id = $1`,
    [token.id],
  );

  await asUser1(async () => {
    await assert.rejects(
      () => rotateToken(token.id),
      /connected AI client\. Disconnect it and connect again/,
    );
  });
  const acting = (await authenticateToken(raw))!;
  await runWithIdentity(acting, async () => {
    await assert.rejects(
      () => rotateToken(token.id),
      /connected AI client can't create or change API tokens/,
    );
  });
});

test("rerolling a token that administers the instance needs an instance admin", async () => {
  const { token } = await asUser1(() =>
    createToken({ name: "Ops", instanceAdmin: true }),
  );
  await db.execute(
    `update users set is_instance_admin = false where id = '${USER_1}'`,
  );
  const before = (
    await db.select().from(apiTokens).where(eq(apiTokens.id, token.id))
  )[0]!;

  await asUser1(async () => {
    await assert.rejects(() => rotateToken(token.id), /Only an instance admin/);
  });
  const after = (
    await db.select().from(apiTokens).where(eq(apiTokens.id, token.id))
  )[0]!;
  assert.equal(after.tokenHash, before.tokenHash, "the secret changed anyway");
});

test("every team the token reaches gets the trail entry", async () => {
  await alsoMemberOfB(db);
  const { token } = await asUser1(() =>
    createToken({ name: "CI", teamIds: [TEAM_A, TEAM_B] }),
  );
  await asUser1(() => rotateToken(token.id));

  for (const teamId of [TEAM_A, TEAM_B]) {
    const rows = (
      await pg.query(
        `select message, type from activities where team_id = $1 and message like 'Rerolled%'`,
        [teamId],
      )
    ).rows as { message: string; type: string }[];
    assert.deepEqual(
      rows,
      [{ message: "Rerolled the CI API token", type: "security" }],
      `team ${teamId} was not told`,
    );
  }
});
