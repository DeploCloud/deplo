import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { makeTestDb, type TestDb } from "../../db/test-harness";
import { __setTestDb, __resetTestDb } from "../../db/client";
import { apiTokens } from "../../db/schema/control-plane/api-tokens";
import { runWithIdentity } from "../../auth/request-context";
import { type Capability } from "../../types/identity";
import { seedIdentity, TEAM_A, USER_1 } from "../leaf-test-helpers";
import { authenticateToken } from "./authenticate";
import { createToken, updateToken } from "./mint";
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

test("an omitted expiry is ninety days, an explicit null is never", async () => {
  const { token } = await asUser1(() => createToken({ name: "Default" }));
  assert.ok(token.expiresAt, "an omitted expiry must not mean forever");
  const days = (Date.parse(token.expiresAt!) - Date.now()) / 86_400_000;
  assert.ok(days > 89 && days < 91, `expected ~90 days, got ${days}`);

  const forever = await asUser1(() =>
    createToken({ name: "Forever", expiresAt: null }),
  );
  assert.equal(forever.token.expiresAt, null);
  const rows = await db
    .select()
    .from(apiTokens)
    .where(eq(apiTokens.name, "Forever"));
  assert.equal(rows[0]!.expiresAt, null);
});

test("a token that expires can't mint or re-author a successor that outlives it", async () => {
  const hour = 60 * 60 * 1000;
  const inOneDay = new Date(Date.now() + 24 * hour).toISOString();
  const a = await asUser1(() =>
    createToken({
      name: "a",
      capabilities: ["view", "manage_tokens"],
      expiresAt: inOneDay,
    }),
  );
  const asA = <T>(fn: () => Promise<T>): Promise<T> =>
    runWithIdentity(
      {
        userId: USER_1,
        teamId: TEAM_A,
        token: {
          id: a.token.id,
          capabilities: ["view", "manage_tokens"] as Capability[],
          instanceAdmin: false,
          scope: null,
        },
      },
      fn,
    );
  await asA(async () => {
    const inherited = await createToken({
      name: "inherits",
      capabilities: ["view"],
    });
    assert.ok(inherited.token.expiresAt);
    assert.ok(
      Date.parse(inherited.token.expiresAt!) <= Date.parse(a.token.expiresAt!),
      "a successor outlived the token that minted it",
    );
    await assert.rejects(
      () =>
        createToken({
          name: "later",
          capabilities: ["view"],
          expiresAt: new Date(Date.now() + 48 * hour).toISOString(),
        }),
      /expire no later/i,
    );
    const ok = await createToken({
      name: "sooner",
      capabilities: ["view"],
      expiresAt: new Date(Date.now() + hour).toISOString(),
    });
    assert.ok(ok.token.expiresAt);
    await assert.rejects(
      () => updateToken({ id: a.token.id, name: "a", expiresAt: null }),
      /expire no later/i,
      "a token can't un-expire itself",
    );
    await updateToken({ id: a.token.id, name: "still a" });
  });
});
