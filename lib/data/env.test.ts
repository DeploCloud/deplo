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
import { listAllAppEnv } from "./env";

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
