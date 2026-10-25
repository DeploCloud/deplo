import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PGlite } from "@electric-sql/pglite";

process.env.DEPLO_DATA_DIR = mkdtempSync(join(tmpdir(), "deplo-pg-"));

import { makeTestDb, type TestDb } from "../../db/test-harness";
import { __setTestDb, __resetTestDb } from "../../db/client";
import { runWithIdentity } from "../../auth/request-context";
import { seedIdentity, TEAM_A, USER_1 } from "../identity-test-helpers";
import { seedServer, TRUNCATE_PROJECT_GRAPH } from "../app-graph-test-helpers";
import { createApp } from "./create";

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
  await pg.exec(`${TRUNCATE_PROJECT_GRAPH}
    truncate table users, teams restart identity cascade;`);
  await seedIdentity(db, {
    users: [{ id: USER_1, teamId: TEAM_A, role: "owner" }],
  });
  await seedServer(db);
});

const asUser1 = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);

test("an app cannot be created from an image Deplo built for another app", async () => {
  await assert.rejects(
    asUser1(() =>
      createApp({
        name: "copycat",
        source: "docker-image",
        dockerImage: "deplo/victim:dpl_0a1b2c3d",
        repo: null,
        deploy: false,
      }),
    ),
    /a name under `deplo\/`/,
  );
  await assert.rejects(
    asUser1(() =>
      createApp({
        name: "copycat-stack",
        source: "compose",
        repo: null,
        compose:
          "services:\n  web:\n    image: docker.io/deplo/victim:dpl_0a1b2c3d\n",
        deploy: false,
      }),
    ),
    /Service `web` uses `docker.io\/deplo\/victim:dpl_0a1b2c3d`/,
  );
  const ok = await asUser1(() =>
    createApp({
      name: "plain",
      source: "docker-image",
      dockerImage: "acme/deplo:1.0",
      repo: null,
      deploy: false,
    }),
  );
  assert.equal(ok.name, "plain");
});
