import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { PGlite } from "@electric-sql/pglite";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { runWithIdentity } from "../auth/request-context";
import { seedIdentity, TEAM_A } from "./identity-test-helpers";
import {
  seedApp,
  seedServer,
  SERVER_1,
  TRUNCATE_PROJECT_GRAPH,
} from "./app-graph-test-helpers";
import { RestartEvent_Kind, type RestartEvent } from "../agent/gen/agent";
import { recordContainerSample } from "../monitoring/container-history";
import type { ContainerMetricsSample } from "./container-metrics";
import { applyRestartEvents } from "./restart-events";
import type {
  AgentConnection,
  AgentConsoleInstance,
} from "../infra/agent-client/connection";
import { __setAgentConnectorForTest } from "../infra/agent-client/connect";
import { displayStatus } from "../apps/display-status";
import { getAppRuntime } from "./console";
import { loadOverviewAppStates } from "./console/overview-app-states";

let db: TestDb;
let pg: PGlite;
const OWNER = "u_owner";
let seq = 0;

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
});

function instance(
  over: Partial<AgentConsoleInstance> = {},
): AgentConsoleInstance {
  return {
    name: "deplo-web",
    service: "web",
    image: "deplo/web:1",
    running: true,
    exposed: true,
    user: "root",
    workdir: "/",
    openStdin: false,
    tty: false,
    state: "running",
    health: "",
    restartCount: 0,
    startedAtUnix: 1,
    answer: "",
    ...over,
  };
}

// The runtime cache is per app id and lasts seconds, so each case seeds its own app.
async function freshApp(): Promise<string> {
  const id = `prj_health_${++seq}`;
  await seedApp(db, { id, slug: `web${seq}`, teamId: TEAM_A });
  return id;
}

function agentReporting(listed: () => AgentConsoleInstance[]) {
  let probes = 0;
  __setAgentConnectorForTest(
    async () =>
      ({
        listInstances: async () => listed(),
        probeHttp: async () => {
          probes++;
          return { status: 200 };
        },
        inspect: async () => ({
          exists: true,
          running: true,
          state: "running",
        }),
        close: () => {},
      }) as unknown as AgentConnection,
  );
  return { probes: () => probes };
}

const runtimeOf = (appId: string) =>
  runWithIdentity({ userId: OWNER, teamId: TEAM_A }, () =>
    getAppRuntime(appId),
  );

test("the page shows the verdict the server agent reports", async () => {
  const cases = [
    ["answering", "healthy"],
    ["not_answering", "unhealthy"],
    ["starting", "starting"],
  ] as const;
  for (const [answer, health] of cases) {
    const appId = await freshApp();
    agentReporting(() => [instance({ answer })]);
    const rt = await runtimeOf(appId);
    assert.equal(rt?.containers[0].health, health, answer);
  }
});

test("an App with replicas counts its replicas, with no container left to create", async () => {
  const id = await freshApp();
  const slug = `web${seq}`;
  agentReporting(() =>
    [1, 2, 3].map((n) =>
      instance({
        name: `deplo-${slug}-deplo-${slug}-${n}`,
        service: `deplo-${slug}`,
      }),
    ),
  );
  const rt = await runtimeOf(id);
  assert.deepEqual([rt?.running, rt?.total, rt?.missing], [3, 3, []]);
  assert.equal(displayStatus("active", rt), "active");
});

test("a verdict moves with the agent, with no page open in between", async (t) => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  let answer = "answering";
  const appId = await freshApp();
  agentReporting(() => [instance({ answer })]);
  assert.equal((await runtimeOf(appId))?.unhealthy, 0);
  // Nobody looks while the app hangs; the next look finds the agent's verdict.
  answer = "not_answering";
  now += 60_000;
  const rt = await runtimeOf(appId);
  assert.equal(rt?.unhealthy, 1);
  assert.equal(displayStatus("active", rt), "unhealthy");
});

test("the panel runs no probe of its own", async () => {
  const appId = await freshApp();
  const agent = agentReporting(() => [instance({ answer: "answering" })]);
  await runtimeOf(appId);
  assert.equal(agent.probes(), 0);
});

test("an agent that reports nothing never reads as healthy", async () => {
  const appId = await freshApp();
  agentReporting(() => [instance({ answer: "" })]);
  const rt = await runtimeOf(appId);
  assert.equal(rt?.containers[0].health, "");
  assert.equal(rt?.unhealthy, 0);
});

test("an image's own failing check still shows through", async () => {
  const appId = await freshApp();
  agentReporting(() => [
    instance({ answer: "answering", health: "unhealthy" }),
  ]);
  assert.equal((await runtimeOf(appId))?.containers[0].health, "unhealthy");
});

test("with telemetry open, the Overview still reads the verdict for an App its server agent restarted", async () => {
  const appId = await freshApp();
  agentReporting(() => [instance({ answer: "not_answering" })]);
  // Telemetry knows Docker's health only, and Docker has no complaint.
  recordContainerSample({
    ...({} as ContainerMetricsSample),
    id: appId,
    online: true,
    ts: Date.now(),
    running: 1,
    containers: 1,
  });
  const overview = async () =>
    (
      await runWithIdentity({ userId: OWNER, teamId: TEAM_A }, () =>
        loadOverviewAppStates([appId], async (id) => (await runtimeOf(id))!),
      )
    )[0].runtime;
  assert.equal((await overview())?.unhealthy, 0);

  // The server agent restarted it for not answering: from here its verdict is the one shown.
  await applyRestartEvents(SERVER_1, [
    {
      ...({} as RestartEvent),
      kind: RestartEvent_Kind.KIND_RESTARTED,
      slug: `web${seq}`,
      unansweredS: 90,
    },
  ]);
  let rt = await overview();
  for (let i = 0; i < 50 && !rt?.unhealthy; i++) {
    await new Promise((r) => setTimeout(r, 10));
    rt = await overview();
  }
  assert.equal(rt?.unhealthy, 1);
});

test("the Overview follows the same verdict", async () => {
  const appId = await freshApp();
  agentReporting(() => [instance({ answer: "not_answering" })]);
  const states = await runWithIdentity({ userId: OWNER, teamId: TEAM_A }, () =>
    loadOverviewAppStates([appId], async (id) => (await runtimeOf(id))!),
  );
  // Overview reads the probe once telemetry has none for the app.
  for (let i = 0; i < 20 && !states[0].runtime?.unhealthy; i++) {
    await new Promise((r) => setTimeout(r, 10));
    const again = await runWithIdentity({ userId: OWNER, teamId: TEAM_A }, () =>
      loadOverviewAppStates([appId], async (id) => (await runtimeOf(id))!),
    );
    states[0] = again[0];
  }
  assert.equal(states[0].runtime?.unhealthy, 1);
});
