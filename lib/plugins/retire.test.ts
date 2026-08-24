import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { installedPlugins as installedPluginsTable } from "../db/schema/control-plane";
import {
  seedIdentity,
  TEAM_A,
  TEAM_B,
  USER_1,
} from "../data/leaf-test-helpers";
import { retireInstalledPlugins } from "./retire";

/**
 * The retirement sweep (ADR-0013). The teardown itself is Docker, so it is
 * injected — what these assert is the part that can strand a container: which
 * slug gets torn down, and that a row survives a failed teardown so the next
 * boot tries again.
 */

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
  await pg.exec(
    `truncate table installed_plugins, users, teams restart identity cascade;`,
  );
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      { id: "user_2", teamId: TEAM_B, role: "owner" },
    ],
  });
});

async function seedPlugin(
  id: string,
  teamId: string,
  slug: string,
): Promise<void> {
  await db.insert(installedPluginsTable).values({
    id,
    teamId,
    catalogId: "relay",
    slug,
    version: "1.0.0",
    createdAt: "2026-01-02T00:00:00.000Z",
  });
}

const remaining = () => db.select().from(installedPluginsTable);

test("an empty table is a no-op — nothing is torn down", async () => {
  const torn: string[] = [];
  assert.equal(
    await retireInstalledPlugins(async (s) => {
      torn.push(s);
    }),
    0,
  );
  assert.deepEqual(torn, []);
});

test("every installed plugin is torn down by its frozen slug and its row dropped", async () => {
  await seedPlugin("app_1", TEAM_A, "relay__alpha");
  await seedPlugin("app_2", TEAM_B, "relay__beta");

  const torn: string[] = [];
  const count = await retireInstalledPlugins(async (s) => {
    torn.push(s);
  });

  assert.equal(count, 2);
  assert.deepEqual(torn.sort(), ["relay__alpha", "relay__beta"]);
  assert.deepEqual(await remaining(), []);
});

test("a legacy row with no stored slug derives the one the container actually has", async () => {
  await seedPlugin("app_1", TEAM_A, "");

  const torn: string[] = [];
  await retireInstalledPlugins(async (s) => {
    torn.push(s);
  });

  // `pluginSlug("relay", "alpha")` — the value the installer would have frozen.
  assert.deepEqual(torn, ["relay__alpha"]);
  assert.deepEqual(await remaining(), []);
});

test("a failed teardown keeps the row so the next boot retries", async () => {
  await seedPlugin("app_1", TEAM_A, "relay__alpha");
  await seedPlugin("app_2", TEAM_B, "relay__beta");

  const count = await retireInstalledPlugins(async (s) => {
    if (s === "relay__alpha") throw new Error("daemon unreachable");
  });

  assert.equal(count, 1);
  const left = await remaining();
  assert.equal(left.length, 1);
  assert.equal(left[0].slug, "relay__alpha");
});
