import { test, before, after } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { seedIdentity, TEAM_A, TEAM_B } from "../data/identity-test-helpers";
import { teamsForServerAlerts } from "./server-teams";

let db: TestDb;
let pg: PGlite;

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
  await seedIdentity(db);
});

after(async () => {
  __resetTestDb();
  await pg.close();
});

// c46: two teams created in the same instant tied for the first: a server no team uses alerts the same one each time.
test("a server no team uses alerts the oldest team, the lower id on a tie", async () => {
  await pg.exec(
    `update teams set created_at = '2026-01-01T00:00:00.000Z' where id in ('${TEAM_A}', '${TEAM_B}');`,
  );
  // Rewritten last, TEAM_A is the row a scan meets second.
  await pg.exec(`update teams set name = name where id = '${TEAM_A}';`);
  assert.deepEqual(await teamsForServerAlerts("srv_nobody"), [TEAM_A]);
});
