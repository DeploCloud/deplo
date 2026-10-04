import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { runWithIdentity } from "../auth/request-context";
import { seedIdentity, TEAM_A, TEAM_B, USER_1 } from "./identity-test-helpers";
import { TRUNCATE_PROJECT_GRAPH, seedApp } from "./app-graph-test-helpers";
import { seedServerRow } from "./infra-test-helpers";
import { listRunningAppsOnServer } from "./servers/running-apps";

let db: TestDb;
let pg: PGlite;

const SERVER = "srv_target";
const OTHER = "srv_other";

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
      { id: "user_member", teamId: TEAM_A, role: "member" },
    ],
  });
  await seedServerRow(db, { id: SERVER, name: "target", ip: "192.0.2.10" });
  await seedServerRow(db, { id: OTHER, name: "other", ip: "192.0.2.11" });
});

test("lists every team's running apps on the server, linking only the viewer's teams", async () => {
  await seedApp(db, { id: "prj_web", serverId: SERVER });
  await seedApp(db, { id: "prj_api", serverId: SERVER, teamId: TEAM_B });
  await seedApp(db, { id: "prj_off", serverId: SERVER, status: "idle" });
  await seedApp(db, { id: "prj_far", serverId: OTHER });

  const apps = await runWithIdentity({ userId: USER_1, teamId: TEAM_A }, () =>
    listRunningAppsOnServer(SERVER),
  );

  assert.deepEqual(
    apps.map((a) => [a.id, a.teamSlug]),
    [
      ["prj_web", "alpha"],
      ["prj_api", null],
    ],
  );
});

test("refuses a member who is not an instance admin", async () => {
  await assert.rejects(
    () =>
      runWithIdentity({ userId: "user_member", teamId: TEAM_A }, () =>
        listRunningAppsOnServer(SERVER),
      ),
    /instance admin/,
  );
});
