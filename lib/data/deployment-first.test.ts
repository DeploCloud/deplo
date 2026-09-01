import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { PGlite } from "@electric-sql/pglite";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { runWithIdentity } from "../auth/request-context";
import {
  seedIdentity,
  TRUNCATE_IDENTITY,
  TEAM_A,
} from "./identity-test-helpers";
import {
  seedServer,
  seedApp,
  seedDeployment,
  TRUNCATE_PROJECT_GRAPH,
} from "./app-graph-test-helpers";
import { getDeployment, isFirstDeployment } from "./deployments";

/**
 * `isFirstDeployment` against pglite - what gates the confetti on the
 * deployment page.
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

const OWNER = "u_owner";
const SVC = "prj_svc";
const SVC2 = "prj_svc2";

const at = (n: number) => `2026-01-01T00:00:0${n}.000Z`;

const first = (id: string) =>
  runWithIdentity({ userId: OWNER, teamId: TEAM_A }, async () => {
    const dep = await getDeployment(id);
    assert.ok(dep);
    return isFirstDeployment(dep);
  });

beforeEach(async () => {
  await pg.exec(TRUNCATE_PROJECT_GRAPH);
  await pg.exec(TRUNCATE_IDENTITY);
  await seedIdentity(db, {
    teams: [{ id: TEAM_A, slug: "alpha" }],
    users: [{ id: OWNER, teamId: TEAM_A, role: "owner" }],
  });
  await seedServer(db);
  await seedApp(db, { id: SVC, teamId: TEAM_A });
  await seedApp(db, { id: SVC2, teamId: TEAM_A, slug: "svc2" });
});

test("only the app's oldest deployment is the first one", async () => {
  await seedDeployment(db, { id: "d1", appId: SVC, createdAt: at(1) });
  await seedDeployment(db, { id: "d2", appId: SVC, createdAt: at(2) });

  assert.equal(await first("d1"), true);
  assert.equal(await first("d2"), false);
});

test("another app's older builds don't count", async () => {
  await seedDeployment(db, { id: "other", appId: SVC2, createdAt: at(1) });
  await seedDeployment(db, { id: "d1", appId: SVC, createdAt: at(2) });

  assert.equal(await first("d1"), true);
});
