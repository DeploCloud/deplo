import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { PGlite } from "@electric-sql/pglite";
import { NextRequest } from "next/server";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { runWithIdentity } from "../auth/request-context";
import { seedIdentity, TEAM_A } from "./identity-test-helpers";
import {
  seedApp,
  seedServer,
  TRUNCATE_PROJECT_GRAPH,
} from "./app-graph-test-helpers";
import * as attach from "../attach/session";
import type { AttachHandle } from "../infra/docker";
import { memberHoldsTeamWide } from "../membership";

import { POST as appPost } from "@/app/api/apps/[id]/attach/route";
import { POST as dbPost } from "@/app/api/databases/[id]/attach/route";

let db: TestDb;
let pg: PGlite;
const APP = "prj_console";
const DBA = "u_dba";
const opened: string[] = [];

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
});
after(async () => {
  __resetTestDb();
  await pg.close();
});
afterEach(() => {
  for (const id of opened.splice(0)) attach.destroy(id);
});

beforeEach(async () => {
  await pg.exec(`${TRUNCATE_PROJECT_GRAPH}
    truncate table membership_capabilities, memberships, users, teams
    restart identity cascade;`);
  await seedIdentity(db, {
    users: [
      { id: "u_owner", teamId: TEAM_A, role: "owner" },
      {
        id: DBA,
        teamId: TEAM_A,
        role: "member",
        capabilities: ["view", "open_database_console"],
        isInstanceAdmin: false,
      },
    ],
  });
  await seedServer(db);
  await seedApp(db, { id: APP, slug: "console", teamId: TEAM_A });
});

function openAs(kind: "app" | "database", id: string, writes: string[]) {
  const handle: AttachHandle = {
    onData: () => () => {},
    onExit: () => {},
    write: (d) => void writes.push(String(d)),
    close: () => {},
  };
  const s = attach.open(
    {
      kind,
      appId: id,
      teamId: TEAM_A,
      userId: DBA,
      authorize: () => memberHoldsTeamWide(DBA, TEAM_A, "view"),
    },
    "c",
    handle,
  );
  opened.push(s.id);
  return s;
}

const post = (
  route: typeof appPost | typeof dbPost,
  path: string,
  id: string,
  sessionId: string,
) =>
  runWithIdentity({ userId: DBA, teamId: TEAM_A }, () =>
    route(
      new NextRequest(`https://deplo.test/api/${path}/${id}/attach`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId, data: "id\n" }),
      }),
      { params: Promise.resolve({ id }) },
    ),
  );

test("an app console session can't be driven through the database route", async () => {
  const writes: string[] = [];
  const s = openAs("app", APP, writes);

  assert.equal((await post(appPost, "apps", APP, s.id)).status, 403);
  assert.equal((await post(dbPost, "databases", APP, s.id)).status, 404);
  assert.deepEqual(writes, []);
});

test("a database console session can't be driven through the app route", async () => {
  const writes: string[] = [];
  const s = openAs("database", "db_main", writes);

  assert.equal((await post(appPost, "apps", "db_main", s.id)).status, 404);
  assert.equal((await post(dbPost, "databases", "db_main", s.id)).status, 200);
  assert.deepEqual(writes, ["id\n"]);
});
