// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { appMounts as appMountsTable } from "../db/schema/control-plane";
import { runWithIdentity } from "../auth/request-context";
import { seedIdentity, TEAM_A, USER_1 } from "./identity-test-helpers";
import {
  seedServer,
  seedApp,
  TRUNCATE_PROJECT_GRAPH,
} from "./app-graph-test-helpers";
import { __setAgentConnectorForTest } from "../infra/agent-client";
import { writeAppFile } from "./app-files";

/**
 * A compose stack's config files live in `app_mounts` and the agent re-writes them
 * from there on EVERY bring-up.
 */

let db: TestDb;
let pg: PGlite;

const entry = (path: string) => ({
  path,
  name: path.split("/").pop() ?? path,
  kind: "file",
  size: 1,
  modifiedAt: "2026-01-01T00:00:00.000Z",
});

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
  // The agent is a stub: this is about what the DATABASE does after each write,
  // and the containment rules already have their own tests against a real tree.
  __setAgentConnectorForTest(
    async () =>
      ({
        writeFile: async (_s: string, path: string) => entry(path),
        close: () => {},
      }) as unknown as Awaited<
        ReturnType<typeof import("../infra/agent-client").connectAgent>
      >,
  );
});

after(async () => {
  __setAgentConnectorForTest();
  __resetTestDb();
  await pg.close();
});

beforeEach(async () => {
  await pg.exec(`${TRUNCATE_PROJECT_GRAPH}
    truncate table users, teams restart identity cascade;`);
  await seedIdentity(db, {
    users: [{ id: USER_1, teamId: TEAM_A, role: "owner" }],
  });
  await seedServer(db);
  await seedApp(db, { id: "prj_web", slug: "web" });
  await db.insert(appMountsTable).values({
    appId: "prj_web",
    position: 0,
    filePath: "nginx.conf",
    content: "server { listen 80; }\n",
  });
});

const asUser = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);

const mounts = () =>
  db.select().from(appMountsTable).where(eq(appMountsTable.appId, "prj_web"));

test("editing a config file updates the copy the deploy writes back", async () => {
  await asUser(() =>
    writeAppFile("prj_web", "nginx.conf", "server { listen 8080; }\n"),
  );
  assert.deepEqual(
    (await mounts()).map((m) => m.content),
    ["server { listen 8080; }\n"],
  );
});

// An ordinary file in the tree is not a config file, and must not become one.
test("a file that is not a config file leaves the rows alone", async () => {
  await asUser(() => writeAppFile("prj_web", "notes.txt", "hello"));
  assert.deepEqual(
    (await mounts()).map((m) => m.filePath),
    ["nginx.conf"],
  );
});
