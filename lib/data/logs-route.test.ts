import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { PGlite } from "@electric-sql/pglite";
import { NextRequest } from "next/server";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { eq } from "drizzle-orm";
import { runWithIdentity, type RequestIdentity } from "../auth/request-context";
import { session } from "../db/schema/auth";
import { users } from "../db/schema/control-plane/identity";
import { apiTokens } from "../db/schema/control-plane/api-tokens";
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

// Opens a real log stream as `identity` against a fake agent, then lets `revoke` take access away.
async function streamOutlives(
  identity: RequestIdentity,
  revoke: () => Promise<unknown>,
) {
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

  const res = await runWithIdentity(identity, () =>
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
  assert.match(await next(), /before/, "a viewer in good standing still reads");

  await revoke();
  await logs.recheckAccess();
  push(Buffer.from("SECRET-after-revoke\n"));

  let rest = "";
  const stuck = setTimeout(() => void reader.cancel(), 2_000);
  for (let r = await reader.read(); !r.done; r = await reader.read())
    rest += text.decode(r.value);
  clearTimeout(stuck);
  assert.match(rest, /event: failure\ndata: "forbidden"/);
  assert.doesNotMatch(rest, /SECRET-after-revoke/);
}

const asOther = { userId: OTHER, teamId: TEAM_A };

test("a removed member's open log stream ends on the next access check", () =>
  streamOutlives(asOther, () =>
    runWithIdentity({ userId: OWNER, teamId: TEAM_A }, () =>
      removeMember(OTHER),
    ),
  ));

test("a suspended user's open log stream ends on the next access check", () =>
  streamOutlives(asOther, () =>
    db.update(users).set({ suspended: true }).where(eq(users.id, OTHER)),
  ));

test("a signed-out or expired session ends the stream it opened", async () => {
  const seed = (id: string) =>
    db.insert(session).values({
      id,
      userId: OTHER,
      token: `t_${id}`,
      expiresAt: new Date(Date.now() + 3_600_000),
    });
  await seed("ses_out");
  await streamOutlives({ ...asOther, sessionId: "ses_out" }, () =>
    db.delete(session).where(eq(session.id, "ses_out")),
  );
  await seed("ses_old");
  await streamOutlives({ ...asOther, sessionId: "ses_old" }, () =>
    db
      .update(session)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(session.id, "ses_old")),
  );
});

test("a revoked or expired API token ends the stream it opened", async () => {
  const seed = (id: string) =>
    db.insert(apiTokens).values({
      id,
      userId: OTHER,
      name: id,
      prefix: "deplo_x",
      tokenHash: `h_${id}`,
      createdAt: new Date().toISOString(),
    });
  const asToken = (id: string): RequestIdentity => ({
    ...asOther,
    token: {
      id,
      capabilities: ["view", "view_logs"],
      scope: null,
      instanceAdmin: false,
    },
  });
  await seed("tok_gone");
  await streamOutlives(asToken("tok_gone"), () =>
    db.delete(apiTokens).where(eq(apiTokens.id, "tok_gone")),
  );
  await seed("tok_old");
  await streamOutlives(asToken("tok_old"), () =>
    db
      .update(apiTokens)
      .set({ expiresAt: new Date(Date.now() - 1000).toISOString() })
      .where(eq(apiTokens.id, "tok_old")),
  );
});
