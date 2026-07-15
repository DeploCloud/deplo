import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { runWithIdentity } from "../auth/request-context";
import { seedIdentity, TEAM_A, USER_1 } from "./identity-test-helpers";
import {
  seedServer,
  seedApp,
  TRUNCATE_PROJECT_GRAPH,
} from "./app-graph-test-helpers";
import {
  apps as appsTable,
  domains as domainsTable,
} from "../db/schema/control-plane";
import { listAllAppEnv, listEnv, upsertEnv, renameEnv } from "./env";

/**
 * The app descriptor `listAllAppEnv` hands the Variables page: its logo and its
 * PRIMARY domain are what the shared-var wizard's app cards show, so an app is
 * recognised by sight. A non-primary domain must never take that slot.
 */

let db: TestDb;
let pg: PGlite;

const T0 = "2026-01-01T00:00:00.000Z";

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
});

after(async () => {
  __resetTestDb();
  await pg.close();
});

beforeEach(async () => {
  await pg.exec(`${TRUNCATE_PROJECT_GRAPH}
    truncate table registration_links, membership_capabilities, memberships, users, teams restart identity cascade;`);
  await seedIdentity(db);
  await seedServer(db);
  await seedApp(db, { id: "app_web", slug: "web", teamId: TEAM_A });
  await seedApp(db, { id: "app_bare", slug: "bare", teamId: TEAM_A });
  await db
    .update(appsTable)
    .set({ logo: "https://cdn.example/logo.png" })
    .where(eq(appsTable.id, "app_web"));
  await db.insert(domainsTable).values([
    {
      id: "dom_1",
      appId: "app_web",
      name: "shop.example.com",
      status: "active",
      isPrimary: true,
      ssl: true,
      createdAt: T0,
    },
    {
      id: "dom_2",
      appId: "app_web",
      name: "old.example.com",
      status: "active",
      isPrimary: false,
      ssl: true,
      createdAt: T0,
    },
  ]);
});

test("listAllAppEnv carries each app's logo and PRIMARY domain", async () => {
  const groups = await runWithIdentity({ userId: USER_1, teamId: TEAM_A }, () =>
    listAllAppEnv(),
  );
  const byId = new Map(groups.map((g) => [g.app.id, g.app]));

  const web = byId.get("app_web");
  assert.equal(web?.logo, "https://cdn.example/logo.png");
  assert.equal(web?.primaryDomain, "shop.example.com");

  // An app with neither: both fields are null, never undefined (the cards fall
  // back to the generic glyph + the slug).
  const bare = byId.get("app_bare");
  assert.equal(bare?.logo, null);
  assert.equal(bare?.primaryDomain, null);
});

const asUser1 = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);

test("renameEnv moves the key in place, preserving value, type and identity", async () => {
  await asUser1(() =>
    upsertEnv({ appId: "app_web", key: "OLD_NAME", value: "keepme", type: "plain" }),
  );
  const before = (await asUser1(() => listEnv("app_web"))).find(
    (e) => e.key === "OLD_NAME",
  )!;

  await asUser1(() => renameEnv(before.id, "new_name")); // trims + case-tolerant key rule

  const after = await asUser1(() => listEnv("app_web"));
  assert.equal(after.some((e) => e.key === "OLD_NAME"), false);
  const renamed = after.find((e) => e.key === "new_name")!;
  // Same ROW — the value and type ride along, no new var was minted.
  assert.equal(renamed.id, before.id);
  assert.equal(renamed.value, "keepme");
  assert.equal(renamed.type, "plain");
  assert.equal(after.length, 1);
});

test("renameEnv refuses to collide with an existing key on the same app", async () => {
  await asUser1(() =>
    upsertEnv({ appId: "app_web", key: "ALPHA", value: "a", type: "plain" }),
  );
  await asUser1(() =>
    upsertEnv({ appId: "app_web", key: "BETA", value: "b", type: "plain" }),
  );
  const beta = (await asUser1(() => listEnv("app_web"))).find(
    (e) => e.key === "BETA",
  )!;

  await assert.rejects(
    () => asUser1(() => renameEnv(beta.id, "ALPHA")),
    /already exists/,
  );
  // Neither var was touched — the guard fires before the update.
  const rows = await asUser1(() => listEnv("app_web"));
  assert.deepEqual(rows.map((e) => e.key).sort(), ["ALPHA", "BETA"]);
});

test("renameEnv rejects a malformed key", async () => {
  await asUser1(() =>
    upsertEnv({ appId: "app_web", key: "GOOD", value: "v", type: "plain" }),
  );
  const good = (await asUser1(() => listEnv("app_web"))).find(
    (e) => e.key === "GOOD",
  )!;
  await assert.rejects(
    () => asUser1(() => renameEnv(good.id, "1BAD KEY")),
    /Invalid variable name/,
  );
});

test("renaming to the same key is a harmless no-op", async () => {
  await asUser1(() =>
    upsertEnv({ appId: "app_web", key: "SAME", value: "v", type: "plain" }),
  );
  const v = (await asUser1(() => listEnv("app_web"))).find(
    (e) => e.key === "SAME",
  )!;
  await asUser1(() => renameEnv(v.id, "SAME"));
  const rows = await asUser1(() => listEnv("app_web"));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].key, "SAME");
});
