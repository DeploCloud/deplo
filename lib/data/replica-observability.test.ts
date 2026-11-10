import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { PGlite } from "@electric-sql/pglite";
import { NextRequest } from "next/server";

import { eq } from "drizzle-orm";
import { apps } from "../db/schema/control-plane/apps";
import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { runWithIdentity } from "../auth/request-context";
import { seedIdentity, TEAM_A } from "./identity-test-helpers";
import {
  seedApp,
  seedServer,
  TRUNCATE_PROJECT_GRAPH,
} from "./app-graph-test-helpers";
import type { AttachHandle } from "../infra/docker";
import type { AgentConnection } from "../infra/agent-client/connection";
import { __setAgentConnectorForTest } from "../infra/agent-client/connect";
import { getConsoleInfo, getLogsInfo, resolveAttachTarget } from "./console";
import { appLogsSnapshot } from "./logs-snapshot";
import * as logs from "../logs/session";

import { GET } from "@/app/api/apps/[id]/logs/route";

let db: TestDb;
let pg: PGlite;
const OWNER = "u_owner";
const APP = "prj_web";
const asOwner = { userId: OWNER, teamId: TEAM_A };

const instance = (n: number) => ({
  name: `deplo-web-deplo-web-${n}`,
  service: "deplo-web",
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
});

// A fake agent: three copies of one App, each with its own log stream.
function fakeAgent(copies: number) {
  const opened: { container: string; timestamps?: boolean }[] = [];
  const pushers = new Map<string, (chunk: Buffer) => void>();
  __setAgentConnectorForTest(
    async () =>
      ({
        listInstances: async () =>
          Array.from({ length: copies }, (_, i) => instance(copies - i)),
        followLogs: (
          _appId: string,
          container: string,
          _tail: number,
          opts?: { timestamps?: boolean },
        ) => {
          opened.push({ container, timestamps: opts?.timestamps });
          const handle: AttachHandle = {
            onData: (cb) => {
              pushers.set(container, cb);
              return () => {};
            },
            onExit: () => {},
            write: () => {},
            close: () => {},
          };
          return handle;
        },
        hello: async () => ({ capabilities: [] }),
        close: () => {},
      }) as unknown as AgentConnection,
  );
  return {
    opened,
    say: (n: number, text: string) =>
      pushers.get(`deplo-web-deplo-web-${n}`)!(Buffer.from(text)),
  };
}

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
    users: [{ id: OWNER, teamId: TEAM_A, role: "owner" }],
  });
  await seedServer(db);
  await seedApp(db, { id: APP, slug: "web", teamId: TEAM_A });
});

const streamLogs = (query = "") =>
  runWithIdentity(asOwner, () =>
    GET(new NextRequest(`https://deplo.test/api/apps/${APP}/logs${query}`), {
      params: Promise.resolve({ id: APP }),
    }),
  );

async function readEvents(res: Response, until: RegExp): Promise<string> {
  const reader = res.body!.getReader();
  const text = new TextDecoder();
  let seen = "";
  const stuck = setTimeout(() => void reader.cancel(), 3_000);
  while (!until.test(seen)) {
    const r = await reader.read();
    if (r.done) break;
    seen += text.decode(r.value);
  }
  clearTimeout(stuck);
  await reader.cancel();
  return seen;
}

test("the logs of 3 replicas arrive merged and tagged by replica", async () => {
  const agent = fakeAgent(3);
  const res = await streamLogs();
  assert.equal(res.status, 200);
  assert.deepEqual(agent.opened.map((o) => o.container).sort(), [
    "deplo-web-deplo-web-1",
    "deplo-web-deplo-web-2",
    "deplo-web-deplo-web-3",
  ]);
  agent.say(2, "2026-11-10T10:00:02.000000000Z second\n");
  agent.say(1, "2026-11-10T10:00:01.000000000Z first\n");
  agent.say(3, "2026-11-10T10:00:03.000000000Z third\n");
  const seen = await readEvents(res, /third/);
  const data = [...seen.matchAll(/event: data\ndata: (".*")/g)]
    .map((m) => JSON.parse(m[1]!) as string)
    .join("");
  assert.equal(
    data,
    "web-1 | first\nweb-2 | second\nweb-3 | third\n",
    "one stream, in time order, each line tagged",
  );
  logs.__allSessionIdsForTest().forEach((id) => logs.destroy(id));
});

test("a named replica reads alone, untagged", async () => {
  const agent = fakeAgent(3);
  const res = await streamLogs("?container=deplo-web-deplo-web-2");
  assert.equal(res.status, 200);
  assert.deepEqual(
    agent.opened.map((o) => o.container),
    ["deplo-web-deplo-web-2"],
  );
  agent.say(2, "plain\n");
  const seen = await readEvents(res, /plain/);
  assert.match(seen, /data: "plain\\n"/);
  logs.__allSessionIdsForTest().forEach((id) => logs.destroy(id));
});

test("an App with one copy reads as before", async () => {
  const agent = fakeAgent(1);
  const res = await streamLogs();
  assert.equal(res.status, 200);
  assert.equal(agent.opened.length, 1);
  assert.ok(
    !agent.opened[0]!.timestamps,
    "no timestamps forced on a lone copy",
  );
  agent.say(1, "solo\n");
  assert.match(await readEvents(res, /solo/), /data: "solo\\n"/);
  logs.__allSessionIdsForTest().forEach((id) => logs.destroy(id));
});

test("the log snapshot of replicas is merged and tagged too", async () => {
  const agent = fakeAgent(2);
  const pending = runWithIdentity(asOwner, () => appLogsSnapshot(APP));
  await new Promise((r) => setTimeout(r, 50));
  agent.say(1, "2026-11-10T10:00:01.000000000Z a\n");
  agent.say(2, "2026-11-10T10:00:02.000000000Z b\n");
  const snap = await pending;
  assert.equal(snap.text, "web-1 | a\nweb-2 | b\n");
});

test("the logs viewer offers all replicas first, then each copy", async () => {
  fakeAgent(3);
  const info = await runWithIdentity(asOwner, () => getLogsInfo(APP));
  assert.deepEqual(
    info!.instances.map((i) => [i.name, i.replica]),
    [
      ["replicas:deplo-web", "web · all replicas"],
      ["deplo-web-deplo-web-1", "web-1"],
      ["deplo-web-deplo-web-2", "web-2"],
      ["deplo-web-deplo-web-3", "web-3"],
    ],
  );
});

test("an App with one copy gets no replica entries", async () => {
  fakeAgent(1);
  const info = await runWithIdentity(asOwner, () => getLogsInfo(APP));
  assert.deepEqual(
    info!.instances.map((i) => [i.name, i.replica]),
    [["deplo-web-deplo-web-1", null]],
  );
});

test("the console lists the replicas and opens the one picked", async () => {
  fakeAgent(3);
  await db.update(apps).set({ consoleEnabled: true }).where(eq(apps.id, APP));
  const info = await runWithIdentity(asOwner, () => getConsoleInfo(APP));
  assert.deepEqual(
    info!.instances.map((i) => i.replica),
    ["web-1", "web-2", "web-3"],
  );
  const picked = await runWithIdentity(asOwner, () =>
    resolveAttachTarget(APP, "deplo-web-deplo-web-3"),
  );
  assert.ok(picked.ok, JSON.stringify(picked));
  assert.equal(picked.instance.name, "deplo-web-deplo-web-3");
});
