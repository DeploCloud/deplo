import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

process.env.DEPLO_DATA_DIR = mkdtempSync(join(tmpdir(), "deplo-pg-"));

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { runWithIdentity } from "../auth/request-context";
import {
  appMounts as appMountsTable,
  pendingTeardowns as pendingTeardownsTable,
} from "../db/schema/control-plane";
import { seedIdentity, TEAM_A, TEAM_B, USER_1 } from "./identity-test-helpers";
import {
  seedServer,
  SERVER_1,
  TRUNCATE_PROJECT_GRAPH,
} from "./app-graph-test-helpers";
import { createApp } from "./apps";
import { dropTeardown } from "./teardown-queue";

/**
 * A slug whose stack still awaits teardown on a host is not free: a new app of any
 * team taking it would adopt the old one's named volumes and files.
 */

let db: TestDb;
let pg: PGlite;

const T0 = "2026-01-01T00:00:00.000Z";
const COMPOSE = "services:\n  web:\n    image: nginx:1.27\n";

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
    truncate table pending_teardowns, users, teams restart identity cascade;`);
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      { id: "user_2", teamId: TEAM_B, role: "owner" },
    ],
  });
  await seedServer(db);
});

const asOtherTeam = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: "user_2", teamId: TEAM_B }, fn);

test("a deploy key awaiting teardown keeps its slug taken, previews included", async () => {
  await db.insert(pendingTeardownsTable).values([
    {
      id: "ptd_1",
      serverId: SERVER_1,
      deployKey: "shop",
      projectLabel: "prj_gone",
      label: "shop",
      teamId: TEAM_A,
      nextAttemptAt: T0,
      createdAt: T0,
    },
    {
      id: "ptd_2",
      serverId: SERVER_1,
      deployKey: "store__pr-3",
      projectLabel: "prj_gone2",
      label: "store",
      teamId: TEAM_A,
      nextAttemptAt: T0,
      createdAt: T0,
    },
  ]);
  const shop = await asOtherTeam(() =>
    createApp({
      name: "shop",
      source: "compose",
      repo: null,
      compose: COMPOSE,
      deploy: false,
    }),
  );
  assert.equal(shop.slug, "shop-1");
  const store = await asOtherTeam(() =>
    createApp({
      name: "store",
      source: "compose",
      repo: null,
      // Its own service name: two `web` on one team network would be a clash.
      compose: "services:\n  store:\n    image: nginx:1.27\n",
      deploy: false,
    }),
  );
  assert.equal(store.slug, "store-1");
});

test("a config file's path stays inside the app's files and is never the env-file", async () => {
  const withMount = (filePath: string) => {
    // One service name per app: two stacks answering `cfg` would clash.
    const name = `cfg-${Math.random().toString(36).slice(2, 8)}`;
    return asOtherTeam(() =>
      createApp({
        name,
        source: "compose",
        repo: null,
        compose: `services:\n  ${name}:\n    image: nginx:1.27\n`,
        deploy: false,
        mounts: [{ filePath, content: "x" }],
      }),
    );
  };
  for (const bad of [
    "../x.conf",
    "/../x.conf",
    ".env",
    "/.env",
    "a:b",
    "a$b",
    "",
  ])
    await assert.rejects(() => withMount(bad), /config file|\.env/, bad);
  // A leading slash is folded, as the agent folds it, so the three agree.
  const stored = async (filePath: string) => {
    const app = await withMount(filePath);
    const rows = await db
      .select({ filePath: appMountsTable.filePath })
      .from(appMountsTable)
      .where(eq(appMountsTable.appId, app.id));
    return rows.map((r) => r.filePath);
  };
  assert.deepEqual(await stored("./conf/nginx.conf"), ["conf/nginx.conf"]);
  assert.deepEqual(await stored("/etc/nginx/nginx.conf"), [
    "etc/nginx/nginx.conf",
  ]);
});

test("a queued teardown of a key is dropped when that stack lands on the host again", async () => {
  await db.insert(pendingTeardownsTable).values({
    id: "ptd_stale",
    serverId: SERVER_1,
    deployKey: "shop",
    projectLabel: "prj_shop",
    label: "shop",
    teamId: TEAM_A,
    nextAttemptAt: T0,
    createdAt: T0,
  });
  await dropTeardown(SERVER_1, "shop");
  assert.equal((await db.select().from(pendingTeardownsTable)).length, 0);
});
