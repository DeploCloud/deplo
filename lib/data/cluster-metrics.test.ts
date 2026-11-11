import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { eq } from "drizzle-orm";

import { runWithIdentity } from "../auth/request-context";
import { apps as appsTable } from "../db/schema/control-plane/apps";
import { workloadPlacements } from "../db/schema/control-plane/clusters";
import { __setRunnerForTest } from "../deploy/deploy-queue";
import {
  clearContainerHistory,
  recordMemberSample,
} from "../monitoring/container-history";
import { recordActivity } from "./activity";
import { seedApp, SERVER_1 } from "./app-graph-test-helpers";
import { moveAppToServer } from "./apps/source";
import { AT, failoverLab } from "./cluster-failover-test-helpers";
import {
  getAppMetrics,
  getAppMetricsHistory,
  type ContainerInstanceMetrics,
  type ContainerMetricsSample,
} from "./container-metrics";
import { TEAM_A, TEAM_B, USER_1 } from "./identity-test-helpers";
import { seedServerRow } from "./infra-test-helpers";
import { getAppMetricsMarkers } from "./metrics-markers";
import { runTool } from "../mcp/run-tool-test-helpers";

const lab = failoverLab();
const { asAdmin, eu, web, event, apply } = lab;
const asOtherTeam = <T>(fn: () => Promise<T>) =>
  runWithIdentity({ userId: "user_b", teamId: TEAM_B }, fn);

const APP = "prj_web";
const NOW = Date.now();

beforeEach(() => {
  clearContainerHistory();
  __setRunnerForTest(async () => {});
});

function sample(
  ts: number,
  cpu: number,
  memUsed = 100,
): ContainerMetricsSample {
  return {
    id: APP,
    online: true,
    ts,
    cpu,
    memUsed,
    memLimit: 1000,
    memPct: memUsed / 10,
    netRx: 0,
    netTx: 0,
    blockRead: 0,
    blockWrite: 0,
    pids: 1,
    running: 1,
    containers: 1,
    hostCores: 4,
  };
}

function container(name: string, cpu: number): ContainerInstanceMetrics {
  return {
    name,
    running: true,
    cpu,
    memUsed: 100,
    memLimit: 1000,
    memPct: 10,
    netRx: 0,
    netTx: 0,
    blockRead: 0,
    blockWrite: 0,
    pids: 1,
    state: "running",
    health: "",
    restartCount: 0,
    netNsId: 0,
    netNsHost: false,
  };
}

/** The App "web" spread over both members of "eu": one replica on each. */
async function spread() {
  const cluster = await eu();
  await web(cluster.id);
  await lab.db
    .update(appsTable)
    .set({ replicas: 2 })
    .where(eq(appsTable.id, APP));
  await lab.db.insert(workloadPlacements).values({
    kind: "app",
    workloadId: APP,
    replica: 1,
    memberServerId: "srv_3",
    epoch: 1,
    updatedAt: AT,
  });
  return cluster;
}

const REPLICA = "deplo-prj_web-prj_web-1";

test("an App on two members reads as one total, with each server's share and each copy named with its server", async () => {
  await spread();
  recordMemberSample("srv_2", sample(NOW - 5000, 10), [container(REPLICA, 10)]);
  recordMemberSample("srv_3", sample(NOW - 4000, 30, 300), [
    container(REPLICA, 30),
  ]);
  recordMemberSample("srv_2", sample(NOW, 20), [container(REPLICA, 20)]);

  const history = await asAdmin(() => getAppMetricsHistory(APP));
  assert.deepEqual(
    history.map((s) => [s.cpu, s.members?.map((m) => [m.server, m.cpu])]),
    [
      [10, [["server-2", 10]]],
      [
        50,
        [
          ["server-2", 20],
          ["server-3", 30],
        ],
      ],
    ],
  );
  assert.equal(history[1].memUsed, 400);

  const live = await asAdmin(() => getAppMetrics(APP));
  assert.equal(live?.cpu, 50);
  assert.deepEqual(live?.unavailable, []);
  assert.deepEqual(
    live?.instances.map((i) => [i.replica, i.server, i.cpu]),
    [
      ["prj_web-1 · server-2", "server-2", 20],
      ["prj_web-1 · server-3", "server-3", 30],
    ],
  );
});

test("a member that sends nothing is named, and the others are still read", async () => {
  await spread();
  recordMemberSample("srv_2", sample(NOW, 20), [container(REPLICA, 20)]);

  const live = await asAdmin(() => getAppMetrics(APP));
  assert.equal(live?.online, true);
  assert.equal(live?.cpu, 20);
  assert.deepEqual(live?.unavailable, ["server-3"]);
  assert.deepEqual(
    live?.instances.map((i) => i.replica),
    ["prj_web-1 · server-2"],
  );
});

test("after a failover the history names both servers, and a marker carries Activity's sentence", async () => {
  const cluster = await eu();
  lab.seq = 0;
  await web(cluster.id);
  recordMemberSample("srv_2", sample(NOW - 60_000, 10), [container("w", 10)]);
  const before = Date.now();
  await apply(
    cluster.id,
    event(cluster.id, "placement", {
      kind: "app",
      workloadId: APP,
      members: ["srv_3"],
      epoch: 1,
    }),
    event(cluster.id, "failed_over", {
      kind: "app",
      workloadId: APP,
      from: "srv_2",
      to: "srv_3",
      reason: "stopped_answering",
    }),
  );
  recordMemberSample("srv_3", sample(NOW, 12), [container("w", 12)]);

  const history = await asAdmin(() => getAppMetricsHistory(APP));
  assert.deepEqual(
    history.map((s) => s.members?.map((m) => m.server)),
    [["server-2"], ["server-3"]],
  );
  const markers = await asAdmin(() => getAppMetricsMarkers(APP));
  assert.deepEqual(
    markers.map((m) => m.label),
    ["Moved web to server-3: server-2 stopped answering"],
  );
  assert.ok(markers[0].ts >= before && markers[0].ts <= Date.now());
  // Where it runs now is one server: nothing is reported missing, and its one copy keeps its plain name.
  const live = await asAdmin(() => getAppMetrics(APP));
  assert.deepEqual(live?.unavailable, undefined);
  assert.deepEqual(
    live?.instances.map((i) => [i.name, i.replica, i.server]),
    [["w", null, undefined]],
  );
});

test("a move a person asked for is marked too", async () => {
  await seedServerRow(lab.db, { id: "srv_4", name: "server-4" });
  await seedApp(lab.db, { id: "prj_solo", slug: "solo" });
  await lab.db
    .update(appsTable)
    .set({ name: "solo" })
    .where(eq(appsTable.id, "prj_solo"));
  await asAdmin(() => moveAppToServer("prj_solo", "srv_4"));
  assert.deepEqual(
    (await asAdmin(() => getAppMetricsMarkers("prj_solo"))).map((m) => m.label),
    ["Moved solo to server-4"],
  );
});

test("only a change of server is marked: a sentence that merely reads like one is not", async () => {
  await seedApp(lab.db, { id: "prj_solo", slug: "solo" });
  // What a folder move and a port change write about an App, word for word.
  for (const message of [
    "Moved solo to marketing",
    "Moved 2 domains to port 8080",
  ])
    await asAdmin(() => recordActivity("app", message, "user_1", "prj_solo"));
  assert.deepEqual(await asAdmin(() => getAppMetricsMarkers("prj_solo")), []);
});

test("an App on one server reads exactly as it did: no shares, no server names, no markers", async () => {
  await seedApp(lab.db, { id: "prj_solo", slug: "solo" });
  const first = { ...sample(NOW - 5000, 7), id: "prj_solo" };
  const second = { ...sample(NOW, 9), id: "prj_solo" };
  recordMemberSample(SERVER_1, first, [container("deplo-solo", 7)]);
  recordMemberSample(SERVER_1, second, [container("deplo-solo", 9)]);

  assert.deepEqual(await asAdmin(() => getAppMetricsHistory("prj_solo")), [
    first,
    second,
  ]);
  assert.deepEqual(await asAdmin(() => getAppMetrics("prj_solo")), {
    ...second,
    unsupported: false,
    instances: [{ ...container("deplo-solo", 9), replica: null }],
  });
  assert.deepEqual(await asAdmin(() => getAppMetricsMarkers("prj_solo")), []);
});

test("another team reads no share, no server name and no marker of the App", async () => {
  const cluster = await spread();
  recordMemberSample("srv_2", sample(NOW - 5000, 10), [container(REPLICA, 10)]);
  recordMemberSample("srv_3", sample(NOW - 4000, 30), [container(REPLICA, 30)]);
  recordMemberSample("srv_2", sample(NOW, 20), [container(REPLICA, 20)]);
  lab.seq = 0;
  await apply(
    cluster.id,
    event(cluster.id, "failed_over", {
      kind: "app",
      workloadId: APP,
      from: "srv_2",
      to: "srv_3",
      reason: "stopped_answering",
    }),
  );
  assert.equal((await asAdmin(() => getAppMetricsMarkers(APP))).length, 1);

  assert.equal(await asOtherTeam(() => getAppMetrics(APP)), null);
  assert.deepEqual(await asOtherTeam(() => getAppMetricsHistory(APP)), []);
  assert.deepEqual(await asOtherTeam(() => getAppMetricsMarkers(APP)), []);
});

const viaMcp = async (tool: string, args: Record<string, unknown>) => {
  const got = await runTool({ userId: USER_1, teamId: TEAM_A }, tool, args);
  assert.equal(got.error, undefined, got.error ?? "");
  // As it goes over the wire: graphql's own objects have no prototype.
  return JSON.parse(JSON.stringify(got.data));
};

test("MCP reads the servers that sent nothing, each server's share and the markers", async () => {
  const cluster = await spread();
  recordMemberSample("srv_2", sample(NOW, 20), [container(REPLICA, 20)]);
  const live = await viaMcp("metrics", { kind: "app", id: APP });
  assert.deepEqual(live.appMetrics.unavailable, ["server-3"]);

  clearContainerHistory();
  recordMemberSample("srv_2", sample(NOW - 60_000, 10), [
    container(REPLICA, 10),
  ]);
  lab.seq = 0;
  await apply(
    cluster.id,
    event(cluster.id, "failed_over", {
      kind: "app",
      workloadId: APP,
      from: "srv_2",
      to: "srv_3",
      reason: "stopped_answering",
    }),
  );
  recordMemberSample("srv_3", sample(NOW, 30), [container(REPLICA, 30)]);

  const history = await viaMcp("metrics_history", { kind: "app", id: APP });
  assert.deepEqual(
    history.appMetricsHistory.map((s: { members: unknown }) => s.members),
    [
      [{ server: "server-2", cpu: 10, memUsed: 100, running: 1 }],
      [{ server: "server-3", cpu: 30, memUsed: 100, running: 1 }],
    ],
  );
  assert.deepEqual(
    history.appMetricsMarkers.map((m: { label: string }) => m.label),
    ["Moved web to server-3: server-2 stopped answering"],
  );
});
