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
import type { AgentConnection } from "../infra/agent-client/connection";
import { __setAgentConnectorForTest } from "../infra/agent-client/connect";
import { removeMember } from "./members/removal";

import { DELETE, GET } from "@/app/api/apps/[id]/logs/route";

let db: TestDb;
let pg: PGlite;
const APP = "prj_logged";
const OWNER = "u_owner";
const OTHER = "u_other";

function inertHandle(): AttachHandle {
  return {
    onData: () => () => {},
    onExit: () => {},
    write: () => {},
    close: () => {},
  };
}

const openAs = (appId: string, userId: string) =>
  logs.open(
    { appId, teamId: TEAM_A, userId, authorize: async () => true },
    `deplo-${appId}-1`,
    inertHandle(),
  );

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
});
after(async () => {
  __setAgentConnectorForTest();
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
      {
        id: OTHER,
        teamId: TEAM_A,
        role: "member",
        capabilities: ["view", "view_logs"],
        isInstanceAdmin: false,
      },
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
  const session = openAs(APP, OWNER);

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

  await del(OWNER, session.id);
  assert.equal(
    logs.get(session.id, APP),
    undefined,
    "the opener's own DELETE still closes the stream",
  );
});

test("a session id from another app is not this app's to close", async () => {
  await seedApp(db, { id: "prj_second", slug: "second", teamId: TEAM_A });
  const session = openAs("prj_second", OWNER);
  await del(OWNER, session.id);
  assert.ok(
    logs.get(session.id, "prj_second"),
    "the route scopes the lookup to the app in its own URL",
  );
  logs.destroy(session.id);
});

test("a removed member's open log stream ends on the next access check", async () => {
  let push: (chunk: Buffer) => void = () => {};
  const instance = {
    name: "deplo-logged-1",
    service: "logged",
    image: "img",
    running: true,
    exposed: true,
    user: "",
    workdir: "",
    openStdin: false,
    tty: false,
    state: "running",
    health: "",
    restartCount: 0,
    startedAtUnix: 0,
  };
  __setAgentConnectorForTest(
    async () =>
      ({
        listInstances: async () => [instance],
        followLogs: () => ({
          ...inertHandle(),
          onData: (cb: (chunk: Buffer) => void) => {
            push = cb;
            return () => {};
          },
        }),
        close: () => {},
      }) as unknown as AgentConnection,
  );

  const res = await runWithIdentity({ userId: OTHER, teamId: TEAM_A }, () =>
    GET(new NextRequest(`https://deplo.test/api/apps/${APP}/logs`), {
      params: Promise.resolve({ id: APP }),
    }),
  );
  assert.equal(res.status, 200);
  const reader = res.body!.getReader();
  const text = new TextDecoder();
  const next = async () => text.decode((await reader.read()).value);
  assert.match(await next(), /event: session/);

  await logs.recheckAccess();
  push(Buffer.from("before\n"));
  assert.match(await next(), /before/, "a member in good standing still reads");

  await runWithIdentity({ userId: OWNER, teamId: TEAM_A }, () =>
    removeMember(OTHER),
  );
  await logs.recheckAccess();
  push(Buffer.from("SECRET-after-removal\n"));

  let rest = "";
  for (let r = await reader.read(); !r.done; r = await reader.read())
    rest += text.decode(r.value);
  assert.match(rest, /event: failure\ndata: "forbidden"/);
  assert.doesNotMatch(rest, /SECRET-after-removal/);
});
