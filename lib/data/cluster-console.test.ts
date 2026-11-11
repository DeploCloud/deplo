import { test, before, after, beforeEach, afterEach } from "node:test";
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
  seedServer,
  SERVER_1,
  TRUNCATE_PROJECT_GRAPH,
} from "./app-graph-test-helpers";
import { seedServerRow } from "./infra-test-helpers";
import * as attach from "../attach/session";
import type { AttachHandle } from "../attach/types";
import type { AgentConnection } from "../infra/agent-client/connection";
import { __setAgentConnectorForTest } from "../infra/agent-client/connect";
import { AgentUnreachableError } from "../infra/agent-client/errors";
import {
  execInContainer,
  getAppRuntime,
  getConsoleInfo,
  getShellLabel,
  resolveAttachTarget,
} from "./console";

import { GET } from "@/app/api/apps/[id]/attach/route";

let db: TestDb;
let pg: PGlite;
const OWNER = "u_owner";
const CLUSTER = "clu_eu";
const A = "srv_a";
const B = "srv_b";
const AT = "2026-01-01T00:00:00.000Z";
const asOwner = { userId: OWNER, teamId: TEAM_A };
const asOther = { userId: "u_other", teamId: TEAM_B };

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
  const asked = new Set<string>();
  const attached: string[] = [];
  const ran: string[] = [];
  const probed: string[] = [];
  __setAgentConnectorForTest(async (serverId) => {
    asked.add(serverId);
    const held = hosts[serverId];
    if (!held || held === "down")
      throw new AgentUnreachableError(`${serverId} is offline`);
    return {
      listInstances: async () => held.map(copy),
      attach: (_appId: string, container: string) => {
        attached.push(`${serverId}/${container}`);
        const handle: AttachHandle = {
          onData: () => () => {},
          onExit: () => {},
          write: () => {},
          close: () => {},
        };
        return handle;
      },
      exec: async (_appId: string, container: string, command: string) => {
        ran.push(`${serverId}/${container}: ${command}`);
        return { stdout: "ok", stderr: "", code: 0, rawMode: false };
      },
      shellLabel: async (_appId: string, container: string) => {
        probed.push(`${serverId}/${container}`);
        return "sh";
      },
      close: () => {},
    } as unknown as AgentConnection;
  });
  return { asked, attached, ran, probed };
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
    truncate table workload_placements, clusters, activities, membership_capabilities,
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

let n = 0;
/** An App in the cluster "eu" with two replicas, one placement row per member given. A new id each time. */
async function clusterApp(members: string[]): Promise<string> {
  const id = `prj_web_${++n}`;
  await seedApp(db, { id, slug: "web", teamId: TEAM_A, serverId: members[0] });
  await db
    .update(apps)
    .set({ clusterId: CLUSTER, replicas: 2, consoleEnabled: true })
    .where(eq(apps.id, id));
  await db.insert(workloadPlacements).values(
    members.map((memberServerId, i) => ({
      kind: "app",
      workloadId: id,
      replica: i,
      memberServerId,
      epoch: 1,
      updatedAt: AT,
    })),
  );
  return id;
}

afterEach(() => {
  for (let i = 1; i <= n; i++) attach.destroyForApp(`prj_web_${i}`);
});

const ON_A = `${replica(1)}@${A}`;
const ON_B = `${replica(1)}@${B}`;

test("the console lists the copies on every member, each named with its server", async () => {
  const app = await clusterApp([A, B]);
  fakeAgents({ [A]: [replica(1)], [B]: [replica(1)] });
  const info = await runWithIdentity(asOwner, () => getConsoleInfo(app));
  assert.deepEqual(
    info?.instances.map((i) => [i.name, i.replica]),
    [
      [ON_A, "web-1 · server-a"],
      [ON_B, "web-1 · server-b"],
    ],
  );
  assert.equal(info?.containerName, ON_A);
  assert.deepEqual(info?.unavailable, []);
});

test("a copy picked there is opened, probed and typed into on its own server", async () => {
  const app = await clusterApp([A, B]);
  const agents = fakeAgents({ [A]: [replica(1)], [B]: [replica(1)] });
  const res = await runWithIdentity(asOwner, () =>
    GET(
      new NextRequest(
        `https://deplo.test/api/apps/${app}/attach?container=${encodeURIComponent(ON_B)}`,
      ),
      { params: Promise.resolve({ id: app }) },
    ),
  );
  assert.equal(res.status, 200);
  await res.body?.cancel();
  assert.deepEqual(agents.attached, [`${B}/${replica(1)}`]);

  assert.equal(
    await runWithIdentity(asOwner, () => getShellLabel(app, ON_B)),
    "sh",
  );
  assert.deepEqual(agents.probed, [`${B}/${replica(1)}`]);

  const out = await runWithIdentity(asOwner, () =>
    execInContainer(app, "ls", ON_B),
  );
  assert.equal(out.output, "ok");
  assert.deepEqual(agents.ran, [`${B}/${replica(1)}: ls`]);
});

test("a member that cannot be reached is named, and the console opens on the others", async () => {
  const app = await clusterApp([A, B]);
  const agents = fakeAgents({ [A]: "down", [B]: [replica(1)] });
  const info = await runWithIdentity(asOwner, () => getConsoleInfo(app));
  assert.equal(info?.running, true);
  assert.deepEqual(
    info?.instances.map((i) => [i.name, i.replica]),
    [[ON_B, "web-1 · server-b"]],
  );
  assert.deepEqual(info?.unavailable, ["server-a"]);

  const target = await runWithIdentity(asOwner, () => resolveAttachTarget(app));
  assert.ok(target.ok);
  assert.equal(target.instance.name, replica(1));
  assert.equal(target.server?.id, B);
  assert.deepEqual(agents.attached, []);
});

test("the runtime strip counts every member's containers, each with its server", async () => {
  const app = await clusterApp([A, B]);
  fakeAgents({ [A]: [replica(1)], [B]: [replica(1)] });
  const rt = await runWithIdentity(asOwner, () => getAppRuntime(app));
  assert.equal(rt?.total, 2);
  assert.equal(rt?.running, 2);
  assert.equal(rt?.unreachable, false);
  assert.deepEqual(rt?.unreachableServers, []);
  assert.deepEqual(
    rt?.containers.map((c) => [c.name, c.server]),
    [
      [ON_A, "server-a"],
      [ON_B, "server-b"],
    ],
  );
});

test("the runtime strip names a member it cannot reach and still counts the others", async () => {
  const app = await clusterApp([A, B]);
  fakeAgents({ [A]: "down", [B]: [replica(1)] });
  const rt = await runWithIdentity(asOwner, () => getAppRuntime(app));
  assert.equal(rt?.unreachable, false, "not unknown as a whole");
  assert.equal(rt?.running, 1);
  assert.deepEqual(rt?.unreachableServers, ["server-a"]);
  assert.deepEqual(
    rt?.containers.map((c) => [c.name, c.server]),
    [[ON_B, "server-b"]],
  );
});

test("with every member out of reach the runtime is unknown and the console says unreachable", async () => {
  const app = await clusterApp([A, B]);
  fakeAgents({ [A]: "down", [B]: "down" });
  const rt = await runWithIdentity(asOwner, () => getAppRuntime(app));
  assert.equal(rt?.unreachable, true);
  assert.deepEqual(
    await runWithIdentity(asOwner, () => resolveAttachTarget(app)),
    { ok: false, reason: "unreachable" },
  );
});

test("another team is told the App does not exist, and no member is asked", async () => {
  const app = await clusterApp([A, B]);
  const agents = fakeAgents({ [A]: [replica(1)], [B]: [replica(1)] });
  assert.equal(await runWithIdentity(asOther, () => getConsoleInfo(app)), null);
  assert.equal(await runWithIdentity(asOther, () => getAppRuntime(app)), null);
  assert.deepEqual(
    await runWithIdentity(asOther, () => resolveAttachTarget(app, ON_B)),
    { ok: false, reason: "not-found" },
  );
  await assert.rejects(
    runWithIdentity(asOther, () => execInContainer(app, "ls", ON_B)),
  );
  const res = await runWithIdentity(asOther, () =>
    GET(new NextRequest(`https://deplo.test/api/apps/${app}/attach`), {
      params: Promise.resolve({ id: app }),
    }),
  );
  assert.equal(res.status, 404);
  assert.deepEqual([...agents.asked], []);
});

test("an App on one server is asked there alone, and reads exactly as before", async () => {
  await seedApp(db, { id: "prj_solo", slug: "web", teamId: TEAM_A });
  const agents = fakeAgents({ [SERVER_1]: ["deplo-web"] });
  const info = await runWithIdentity(asOwner, () => getConsoleInfo("prj_solo"));
  assert.deepEqual(info, {
    containerName: "deplo-web",
    image: "img",
    running: true,
    instances: [{ ...copy("deplo-web"), replica: null }],
    unavailable: [],
  });
  const rt = await runWithIdentity(asOwner, () => getAppRuntime("prj_solo"));
  assert.deepEqual(rt?.containers, [
    {
      name: "deplo-web",
      service: "deplo-web",
      state: "running",
      health: "",
      restartCount: 0,
      startedAtUnix: 0,
      running: true,
      exposed: true,
    },
  ]);
  assert.equal(rt?.unreachableServers, undefined);
  assert.deepEqual([...agents.asked], [SERVER_1]);
});
