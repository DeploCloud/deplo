import { test, before, after, beforeEach } from "node:test";
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
import * as logs from "../logs/session";
import type { AttachHandle } from "../infra/docker";

import { DELETE } from "@/app/api/apps/[id]/logs/route";

/**
 * A live log stream is closed by `DELETE …/logs?sessionId=…`, and the session id
 * is the only thing the route was given to go on — so anyone holding one could
 * cut short somebody else's stream. The id is random, which makes it a nuisance
 * rather than a break-in, but "you can't guess it" is not an authorization rule:
 * ids travel in URLs, logs and shared screens.
 */

let db: TestDb;
let pg: PGlite;
const APP = "prj_logged";
const OWNER = "u_owner";
const OTHER = "u_other";

/** A backing that does nothing — the session layer never inspects it here. */
function inertHandle(): AttachHandle {
  return {
    onData: () => () => {},
    onExit: () => {},
    write: () => {},
    close: () => {},
  };
}

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
    truncate table membership_capabilities, memberships, users, teams
    restart identity cascade;`);
  await seedIdentity(db, {
    users: [
      { id: OWNER, teamId: TEAM_A, role: "owner" },
      { id: OTHER, teamId: TEAM_A, role: "member", isInstanceAdmin: false },
    ],
  });
  await seedServer(db);
  await seedApp(db, { id: APP, slug: "logged", teamId: TEAM_A });
});

const del = (userId: string, sessionId: string) =>
  runWithIdentity({ userId, teamId: TEAM_A }, () =>
    DELETE(
      new NextRequest(
        `https://deplo.test/api/apps/${APP}/logs?sessionId=${sessionId}`,
        { method: "DELETE" },
      ),
      { params: Promise.resolve({ id: APP }) },
    ),
  );

test("only the member who opened a log stream can close it", async () => {
  const session = logs.open(APP, OWNER, "deplo-logged-1", inertHandle());

  // Another member of the same team — holding the session id and nothing else.
  const res = await del(OTHER, session.id);
  assert.equal(
    res.status,
    200,
    "the answer says nothing about whose session it is",
  );
  assert.ok(
    logs.get(session.id, APP),
    "a stranger's DELETE must not cut short a live log stream",
  );

  // The principal that opened it still closes it.
  await del(OWNER, session.id);
  assert.equal(
    logs.get(session.id, APP),
    undefined,
    "the opener's own DELETE still closes the stream",
  );
});

test("a session id from another app is not this app's to close", async () => {
  await seedApp(db, { id: "prj_second", slug: "second", teamId: TEAM_A });
  const session = logs.open(
    "prj_second",
    OWNER,
    "deplo-second-1",
    inertHandle(),
  );
  await del(OWNER, session.id);
  assert.ok(
    logs.get(session.id, "prj_second"),
    "the route scopes the lookup to the app in its own URL",
  );
  logs.destroy(session.id);
});
