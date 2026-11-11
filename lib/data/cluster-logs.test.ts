import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { PGlite } from "@electric-sql/pglite";
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";

import { apps } from "../db/schema/control-plane/apps";
import {
  clusterMembers,
  clusters,
  workloadPlacements,
} from "../db/schema/control-plane/clusters";
import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { runWithIdentity } from "../auth/request-context";
import { seedIdentity, TEAM_A, TEAM_B } from "./identity-test-helpers";
import {
  seedApp,
  seedDeployment,
  seedServer,
  SERVER_1,
  TRUNCATE_PROJECT_GRAPH,
} from "./app-graph-test-helpers";
import { seedServerRow } from "./infra-test-helpers";
import type { AttachHandle } from "../infra/docker";
import type { AgentConnection } from "../infra/agent-client/connection";
import { __setAgentConnectorForTest } from "../infra/agent-client/connect";
import { AgentUnreachableError } from "../infra/agent-client/errors";
import { getLogsInfo } from "./console";
import { appLogsSnapshot } from "./logs-snapshot";
import * as logs from "../logs/session";

import { GET } from "@/app/api/apps/[id]/logs/route";

let db: TestDb;
let pg: PGlite;
const OWNER = "u_owner";
const APP = "prj_web";
const CLUSTER = "clu_eu";
const A = "srv_a";
const B = "srv_b";
const AT = "2026-01-01T00:00:00.000Z";
const T = (n: number) => `2026-11-10T10:00:0${n}.000000000Z`;
const asOwner = { userId: OWNER, teamId: TEAM_A };

const copy = (name: string) => ({
  name,
  service: name.replace(/-\d+$/, ""),
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
const replica = (n: number) => `deplo-web-deplo-web-${n}`;

// One fake agent per server: the containers it holds, or "down" when the server cannot be reached.
function fakeAgents(hosts: Record<string, string[] | "down">) {
  const opened: { server: string; container: string; timestamps?: boolean }[] =
    [];
  const pushers = new Map<string, (chunk: Buffer) => void>();
  const asked = new Set<string>();
  __setAgentConnectorForTest(async (serverId) => {
    asked.add(serverId);
    const held = hosts[serverId];
    if (!held || held === "down")
      throw new AgentUnreachableError(`${serverId} is offline`);
    return {
      listInstances: async () => held.map(copy),
      followLogs: (
        _appId: string,
        container: string,
        _tail: number,
        opts?: { timestamps?: boolean },
      ) => {
        opened.push({
          server: serverId,
          container,
          timestamps: opts?.timestamps,
        });
        const handle: AttachHandle = {
          onData: (cb) => {
            pushers.set(`${serverId}/${container}`, cb);
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
    } as unknown as AgentConnection;
  });
  return {
    opened,
    asked,
    say: (server: string, container: string, text: string) =>
      pushers.get(`${server}/${container}`)!(Buffer.from(text)),
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
    truncate table workload_placements, clusters, membership_capabilities,
    memberships, users, teams restart identity cascade;`);
  await seedIdentity(db, {
    users: [
      { id: OWNER, teamId: TEAM_A, role: "owner" },
      { id: "u_other", teamId: TEAM_B, role: "owner" },
    ],
  });
  await seedServer(db);
  await seedServerRow(db, { id: A, name: "server-a" });
  await seedServerRow(db, { id: B, name: "server-b" });
  await db.insert(clusters).values({ id: CLUSTER, name: "eu", createdAt: AT });
  await db.insert(clusterMembers).values(
    [A, B].map((serverId) => ({
      serverId,
      clusterId: CLUSTER,
      joinedAt: AT,
    })),
  );
});

/** The App "web" in the cluster "eu", one placement row per replica on the members given. */
async function clusterApp(members: string[]) {
  await seedApp(db, {
    id: APP,
    slug: "web",
    teamId: TEAM_A,
    serverId: members[0],
  });
  await db.update(apps).set({ clusterId: CLUSTER }).where(eq(apps.id, APP));
  await db.insert(workloadPlacements).values(
    members.map((memberServerId, i) => ({
      kind: "app",
      workloadId: APP,
      replica: i,
      memberServerId,
      epoch: 1,
      updatedAt: AT,
    })),
  );
}

const streamLogs = (query = "") =>
  runWithIdentity(asOwner, () =>
    GET(new NextRequest(`https://deplo.test/api/apps/${APP}/logs${query}`), {
      params: Promise.resolve({ id: APP }),
    }),
  );

async function readData(res: Response, until: RegExp): Promise<string> {
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
  logs.__allSessionIdsForTest().forEach((id) => logs.destroy(id));
  return [...seen.matchAll(/event: data\ndata: (".*")/g)]
    .map((m) => JSON.parse(m[1]!) as string)
    .join("");
}

test("the logs of an App on two members arrive merged, tagged with replica and member", async () => {
  await clusterApp([A, B]);
  const agents = fakeAgents({ [A]: [replica(1)], [B]: [replica(2)] });
  const res = await streamLogs();
  assert.equal(res.status, 200);
  assert.deepEqual(
    agents.opened.map((o) => `${o.server}/${o.container}`).sort(),
    [`${A}/${replica(1)}`, `${B}/${replica(2)}`],
  );
  agents.say(B, replica(2), `${T(2)} second\n`);
  agents.say(A, replica(1), `${T(1)} first\n`);
  assert.equal(
    await readData(res, /second/),
    "web-1 · server-a | first\nweb-2 · server-b | second\n",
  );
});

const GONE_A =
  "Earlier logs on server-a are unavailable: Deplo cannot reach that server right now.\n";

test("a member that cannot be reached yields one line, and the others keep streaming", async () => {
  await clusterApp([A, B]);
  await db.update(apps).set({ replicas: 2 }).where(eq(apps.id, APP));
  const agents = fakeAgents({ [A]: "down", [B]: [replica(2)] });
  const res = await streamLogs();
  assert.equal(res.status, 200, "not an error");
  agents.say(B, replica(2), `${T(1)} first\n`);
  agents.say(B, replica(2), `${T(2)} second\n`);
  assert.equal(
    await readData(res, /second/),
    `${GONE_A}web-2 · server-b | first\nweb-2 · server-b | second\n`,
  );
});

test("after a failover the member the App left still shows its logs, tagged by server", async () => {
  await clusterApp([B]);
  await seedDeployment(db, { id: "dep_1", appId: APP, serverId: A });
  const agents = fakeAgents({ [A]: ["deplo-web"], [B]: ["deplo-web"] });
  const res = await streamLogs("?container=deplo-web");
  assert.equal(res.status, 200);
  agents.say(A, "deplo-web", `${T(1)} before\n`);
  agents.say(B, "deplo-web", `${T(2)} after\n`);
  assert.equal(
    await readData(res, /after/),
    "server-a | before\nserver-b | after\n",
  );
});

test("after a failover from a dead member, one line says its earlier logs are unavailable", async () => {
  await clusterApp([B]);
  await seedDeployment(db, { id: "dep_1", appId: APP, serverId: A });
  const agents = fakeAgents({ [A]: "down", [B]: ["deplo-web"] });
  const res = await streamLogs("?container=deplo-web");
  assert.equal(res.status, 200);
  agents.say(B, "deplo-web", `${T(2)} after\n`);
  assert.equal(await readData(res, /after/), `${GONE_A}server-b | after\n`);
});

test("once the App is deployed where it runs, the member it left is not asked", async () => {
  await clusterApp([B]);
  await seedDeployment(db, { id: "dep_1", appId: APP, serverId: A });
  await seedDeployment(db, { id: "dep_2", appId: APP, serverId: B });
  const agents = fakeAgents({ [A]: "down", [B]: ["deplo-web"] });
  const res = await streamLogs("?container=deplo-web");
  agents.say(B, "deplo-web", "plain\n");
  assert.equal(await readData(res, /plain/), "plain\n");
  assert.deepEqual([...agents.asked], [B]);
});

test("a member that came back without the App's copies adds nothing", async () => {
  await clusterApp([B]);
  await seedDeployment(db, { id: "dep_1", appId: APP, serverId: A });
  const agents = fakeAgents({ [A]: [], [B]: ["deplo-web"] });
  const res = await streamLogs("?container=deplo-web");
  agents.say(B, "deplo-web", "plain\n");
  assert.equal(await readData(res, /plain/), "plain\n");
});

test("with every member out of reach the logs answer as an offline server does", async () => {
  await clusterApp([A, B]);
  fakeAgents({ [A]: "down", [B]: "down" });
  const res = await streamLogs();
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error: "unreachable" });
});

test("another team is told the App does not exist, and no member is asked", async () => {
  await clusterApp([A, B]);
  const agents = fakeAgents({ [A]: [replica(1)], [B]: [replica(2)] });
  const res = await runWithIdentity({ userId: "u_other", teamId: TEAM_B }, () =>
    GET(new NextRequest(`https://deplo.test/api/apps/${APP}/logs`), {
      params: Promise.resolve({ id: APP }),
    }),
  );
  assert.equal(res.status, 404);
  assert.deepEqual([...agents.asked], []);
  await assert.rejects(
    runWithIdentity({ userId: "u_other", teamId: TEAM_B }, () =>
      appLogsSnapshot(APP),
    ),
    /No such app in this team/,
  );
  assert.deepEqual([...agents.asked], []);
});

test("the log snapshot reads every member too", async () => {
  await clusterApp([A, B]);
  await db.update(apps).set({ replicas: 2 }).where(eq(apps.id, APP));
  const agents = fakeAgents({ [A]: "down", [B]: [replica(2)] });
  const pending = runWithIdentity(asOwner, () => appLogsSnapshot(APP));
  await new Promise((r) => setTimeout(r, 50));
  agents.say(B, replica(2), `${T(1)} hello\n`);
  assert.equal((await pending).text, `${GONE_A}web-2 · server-b | hello\n`);
});

test("an App on one server reads exactly as before: that server alone, untouched chunks", async () => {
  await seedApp(db, { id: APP, slug: "web", teamId: TEAM_A });
  const agents = fakeAgents({ [SERVER_1]: ["deplo-web"] });
  const res = await streamLogs("?container=deplo-web");
  assert.equal(res.status, 200);
  assert.deepEqual(agents.opened, [
    { server: SERVER_1, container: "deplo-web", timestamps: false },
  ]);
  assert.deepEqual([...agents.asked], [SERVER_1]);
  agents.say(SERVER_1, "deplo-web", "no newline yet");
  assert.equal(await readData(res, /yet/), "no newline yet");
});

test("a cluster App on a single member reads like an App on one server", async () => {
  await clusterApp([B]);
  await seedDeployment(db, { id: "dep_1", appId: APP, serverId: B });
  const agents = fakeAgents({ [B]: ["deplo-web"] });
  const res = await streamLogs("?container=deplo-web");
  assert.deepEqual(agents.opened, [
    { server: B, container: "deplo-web", timestamps: false },
  ]);
  agents.say(B, "deplo-web", "no newline yet");
  assert.equal(await readData(res, /yet/), "no newline yet");
});

const picker = async (as = asOwner) =>
  (await runWithIdentity(as, () => getLogsInfo(APP)))?.instances.map((i) => [
    i.name,
    i.replica,
  ]);

test("the picker lists the copies on every member, each named with its server", async () => {
  await clusterApp([A, B]);
  await db.update(apps).set({ replicas: 2 }).where(eq(apps.id, APP));
  // Spread over two servers, each one numbers its own copies from 1.
  fakeAgents({ [A]: [replica(1)], [B]: [replica(1)] });
  assert.deepEqual(await picker(), [
    ["replicas:deplo-web-deplo-web", "web · all replicas"],
    [`${replica(1)}@${A}`, "web-1 · server-a"],
    [`${replica(1)}@${B}`, "web-1 · server-b"],
  ]);
});

test("a copy picked in the picker is read alone, on its own server", async () => {
  await clusterApp([A, B]);
  await db.update(apps).set({ replicas: 2 }).where(eq(apps.id, APP));
  const agents = fakeAgents({ [A]: [replica(1)], [B]: [replica(1)] });
  const res = await streamLogs(
    `?container=${encodeURIComponent(`${replica(1)}@${B}`)}`,
  );
  assert.equal(res.status, 200);
  assert.deepEqual(
    agents.opened.map((o) => `${o.server}/${o.container}`),
    [`${B}/${replica(1)}`],
  );
  agents.say(B, replica(1), `${T(1)} only b\n`);
  assert.match(await readData(res, /only b/), /only b/);
});

test("the picker leaves out a member that cannot be reached, and another team sees nothing", async () => {
  await clusterApp([A, B]);
  await db.update(apps).set({ replicas: 2 }).where(eq(apps.id, APP));
  const agents = fakeAgents({ [A]: "down", [B]: [replica(1)] });
  assert.deepEqual(await picker(), [
    [`${replica(1)}@${B}`, "web-1 · server-b"],
  ]);
  agents.asked.clear();
  assert.equal(await picker({ userId: "u_other", teamId: TEAM_B }), undefined);
  assert.deepEqual([...agents.asked], []);
});
