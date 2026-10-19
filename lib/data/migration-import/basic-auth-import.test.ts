import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { PGlite } from "@electric-sql/pglite";

import { makeTestDb, type TestDb } from "../../db/test-harness";
import { __setTestDb, __resetTestDb } from "../../db/client";
import { runWithIdentity } from "../../auth/request-context";
import { seedIdentity, TEAM_A } from "../identity-test-helpers";
import {
  seedServer,
  seedApp,
  TRUNCATE_PROJECT_GRAPH,
} from "../app-graph-test-helpers";
import { listBasicAuthUsers } from "../basic-auth";
import { importBasicAuth, LOCK_USERNAME } from "./app-extras";

process.env.DEPLO_SECRET = "test-secret-for-basic-auth-import-aaaaaaaaa";

let db: TestDb;
let pg: PGlite;
const OWNER = "u_owner_a";
const VIEWER = "u_viewer_a";
const APP = "app_a";

const as = <T>(userId: string, fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId, teamId: TEAM_A }, fn);

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
    truncate table activities, membership_capabilities, memberships, users, teams restart identity cascade;`);
  await seedIdentity(db, {
    teams: [{ id: TEAM_A, slug: "alpha" }],
    users: [
      { id: OWNER, teamId: TEAM_A, role: "owner" },
      { id: VIEWER, teamId: TEAM_A, role: "viewer" },
    ],
  });
  await seedServer(db);
  await seedApp(db, { id: APP, slug: "alpha-app", teamId: TEAM_A });
});

const names = () =>
  as(OWNER, async () =>
    (await listBasicAuthUsers(APP)).map((u) => u.username).sort(),
  );

test("every user landing is the only case that claims identical protection", async () => {
  const notes: string[] = [];
  await as(OWNER, () =>
    importBasicAuth(APP, [{ username: "alice", password: "pw" }], notes),
  );
  assert.deepEqual(await names(), ["alice"]);
  assert.match(notes.join(" "), /protected exactly as it was/);
});

test("a partial failure names the refused user and never claims identical protection", async () => {
  const notes: string[] = [];
  await as(OWNER, () =>
    importBasicAuth(
      APP,
      [
        { username: "alice", password: "pw" },
        { username: "bad name", password: "pw" },
      ],
      notes,
    ),
  );
  assert.deepEqual(await names(), ["alice"]);
  const said = notes.join(" ");
  assert.match(said, /"bad name"/);
  assert.doesNotMatch(said, /exactly as it was/);
});

test("when no user lands the app is locked, not left open", async () => {
  const notes: string[] = [];
  await as(OWNER, () =>
    importBasicAuth(APP, [{ username: "bad name", password: "pw" }], notes),
  );
  assert.deepEqual(await names(), [LOCK_USERNAME]);
  assert.match(notes.join(" "), /locked/);
  assert.doesNotMatch(notes.join(" "), /exactly as it was/);
});

test("when even the lock is refused the import fails instead of landing open", async () => {
  await assert.rejects(
    as(VIEWER, () =>
      importBasicAuth(APP, [{ username: "alice", password: "pw" }], []),
    ),
    /Do not deploy it/,
  );
});
