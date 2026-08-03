import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PGlite } from "@electric-sql/pglite";

process.env.DEPLO_DATA_DIR = mkdtempSync(join(tmpdir(), "deplo-pg-"));

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { runWithIdentity } from "../auth/request-context";
import { seedIdentity, TEAM_A, TEAM_B, USER_1 } from "./identity-test-helpers";
import { seedServer, seedApp, TRUNCATE_PROJECT_GRAPH } from "./app-graph-test-helpers";
import { setAppComposeUpArgs } from "./apps";
import { loadAppGraph } from "./app-graph-load";

/**
 * The app's extra `docker compose up` flags, at the data layer: they are stored
 * as the deploy edge will send them, refused when they would repoint the command,
 * and never writable across a team boundary.
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
  await pg.exec(`${TRUNCATE_PROJECT_GRAPH}
    truncate table users, teams restart identity cascade;`);
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      { id: "user_2", teamId: TEAM_B, role: "owner" },
    ],
  });
  await seedServer(db);
});

const asUser1 = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);

test("an app starts on the untouched bring-up command", async () => {
  await seedApp(db, { id: "prj_1", teamId: TEAM_A });
  assert.equal((await loadAppGraph("prj_1"))?.composeUpArgs, null);
});

test("flags are stored the way the deploy edge will send them", async () => {
  await seedApp(db, { id: "prj_1", teamId: TEAM_A });
  // Ragged whitespace in, canonical argv out — so the settings page shows the
  // command that actually runs, with no stray spacing to puzzle over.
  await asUser1(() => setAppComposeUpArgs("prj_1", "  --pull   always \n --wait "));
  assert.equal((await loadAppGraph("prj_1"))?.composeUpArgs, "--pull always --wait");
});

test("clearing goes back to the default command", async () => {
  await seedApp(db, { id: "prj_1", teamId: TEAM_A });
  await asUser1(() => setAppComposeUpArgs("prj_1", "--force-recreate"));
  for (const empty of [null, "   "]) {
    await asUser1(() => setAppComposeUpArgs("prj_1", empty));
    assert.equal((await loadAppGraph("prj_1"))?.composeUpArgs, null);
    await asUser1(() => setAppComposeUpArgs("prj_1", "--force-recreate"));
  }
});

test("a flag that would repoint the command never reaches the column", async () => {
  await seedApp(db, { id: "prj_1", teamId: TEAM_A });
  // The validation is here, not only in the form: the same value arrives from
  // the bearer API, and from there it would land in a host's argv.
  await assert.rejects(
    () => asUser1(() => setAppComposeUpArgs("prj_1", "--force-recreate -p other")),
    /Deplo's to set/,
  );
  await assert.rejects(
    () => asUser1(() => setAppComposeUpArgs("prj_1", "compose up -d")),
    /Extra flags only/,
  );
  assert.equal((await loadAppGraph("prj_1"))?.composeUpArgs, null);
});

test("another team's app can't be given flags", async () => {
  await seedApp(db, { id: "prj_1", teamId: TEAM_A });
  await assert.rejects(
    () =>
      runWithIdentity({ userId: "user_2", teamId: TEAM_B }, () =>
        setAppComposeUpArgs("prj_1", "--wait"),
      ),
    /not found/i,
  );
  assert.equal((await loadAppGraph("prj_1"))?.composeUpArgs, null);
});
