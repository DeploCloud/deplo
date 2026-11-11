import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { eq } from "drizzle-orm";

import { HelloResponse } from "../agent/gen/agent";
import { __resetReleaseCacheForTests } from "../agent/release";
import {
  clusterBinaryUpdates,
  clusterMembers,
  clusters as clustersTable,
} from "../db/schema/control-plane/clusters";
import { deploMoves } from "../db/schema/control-plane/deplo-move";
import type { TestDb } from "../db/test-harness";
import { __setClusterPinForTest } from "../infra/agent-client/cluster-host";
import type { FakeClusterHost } from "../infra/agent-client/cluster-test-helpers";
import { SERVER_1 } from "./app-graph-test-helpers";
import { leaderLab, type TestLeader } from "./cluster-leader-test-helpers";
import {
  clusterRolloutTiming,
  runClusterRollout,
} from "./clusters/binary-rollout";
import { getClusterLeader } from "./clusters/leader";
import { moveClusterLeader } from "./clusters/leader-move";
import { superviseClusterLeader } from "./clusters/leader-standby";
import {
  __resetClusterWatchForTest,
  releaseClusterWatchLease,
  runClusterWatchTick,
} from "./clusters/watch-scheduler";
import { invalidateFrozen } from "./deplo-move/freeze";
import { TEAM_B, USER_1 } from "./identity-test-helpers";

const lab = leaderLab();
const { asAdmin, eu, messages, stored } = lab;

let db: TestDb;
let hosts: Record<string, FakeClusterHost>;
let leaders: Record<string, TestLeader>;
beforeEach(() => {
  ({ db, hosts, leaders } = lab);
  clusterRolloutTiming.confirmDelayMs = 0;
  clusterRolloutTiming.confirmTries = 2;
});

function pin(version: string, min = "0.2.0") {
  __setClusterPinForTest({ version, min });
  __resetReleaseCacheForTests();
}

const byDeplo = async (teamId?: string) =>
  (await messages(teamId)).filter((m) => m.startsWith("Deplo: "));

const versions = () =>
  Object.fromEntries(
    Object.entries(hosts).map(([id, h]) => [id, h.status.version]),
  );

/** Cluster eu led from srv_4, both leaders on v0.2.0. */
async function euLedFromSrv4() {
  const cluster = await eu();
  await asAdmin(() => moveClusterLeader(cluster.id, "srv_4"));
  return cluster;
}

const updateRows = () => db.select().from(clusterBinaryUpdates);
const getClusters = () => db.select().from(clustersTable);

test("every leader behind the pin is updated, another server's before Deplo's own machine, and Activity says so", async () => {
  await euLedFromSrv4();
  const order: string[] = [];
  for (const id of ["srv_4", SERVER_1]) {
    const h = hosts[id];
    h.extra.installCluster = async (version, _binaries, relay) => {
      order.push(id);
      h.installs.push({ version, relay, urls: [] });
      h.status = { ...h.status, version, relay };
      return { version, running: true };
    };
  }
  const relays = [hosts.srv_4.status.relay, hosts[SERVER_1].status.relay];
  pin("0.3.0");

  await runClusterRollout();

  assert.deepEqual(order, ["srv_4", SERVER_1]);
  assert.deepEqual(versions(), {
    [SERVER_1]: "0.3.0",
    srv_2: "",
    srv_3: "",
    srv_4: "0.3.0",
  });
  // What ran beside the leader still runs beside it.
  assert.deepEqual(
    [
      hosts.srv_4.installs.at(-1)!.relay,
      hosts[SERVER_1].installs.at(-1)!.relay,
    ],
    relays,
  );
  assert.deepEqual(await byDeplo(), [
    "Deplo: Updated the cluster leader and relay on srv_4 to v0.3.0",
    `Deplo: Updated the cluster leader and relay on ${SERVER_1} to v0.3.0`,
  ]);
  // Another team reads none of it.
  assert.deepEqual(await byDeplo(TEAM_B), []);
  assert.deepEqual(await updateRows(), []);

  // On the pin: the next pass installs nothing.
  const installs = hosts.srv_4.installs.length;
  await runClusterRollout();
  assert.equal(hosts.srv_4.installs.length, installs);
});

test("a leader ahead of the pin is never moved backwards", async () => {
  await euLedFromSrv4();
  hosts.srv_4.status = { ...hosts.srv_4.status, version: "0.4.0" };
  const before = hosts.srv_4.installs.length;
  pin("0.3.0");

  await runClusterRollout();

  assert.equal(hosts.srv_4.installs.length, before);
  assert.equal(hosts.srv_4.status.version, "0.4.0");
  assert.equal(hosts[SERVER_1].status.version, "0.3.0");
  assert.deepEqual(await updateRows(), []);
  assert.deepEqual(
    (await byDeplo()).filter((m) => /srv_4/.test(m)),
    [],
  );
});

test("the background pass updates the leaders on its own", async () => {
  await euLedFromSrv4();
  pin("0.3.0");
  try {
    await runClusterWatchTick();
    for (let i = 0; i < 200 && versions()[SERVER_1] !== "0.3.0"; i++)
      await new Promise((r) => setTimeout(r, 10));
    assert.equal(versions().srv_4, "0.3.0");
    assert.equal(versions()[SERVER_1], "0.3.0");
    // Nobody stood in for a leader Deplo itself was restarting.
    assert.deepEqual(await stored((await getClusters())[0].id), {
      server: "srv_4",
      takenOver: false,
      epoch: 2,
    });
  } finally {
    await runClusterRollout();
    __resetClusterWatchForTest();
    for (const h of Object.values(hosts)) h.watch.drop();
    await releaseClusterWatchLease();
  }
});

test("a server whose agent is behind its own pin waits for that update first", async () => {
  await euLedFromSrv4();
  const before = hosts.srv_4.installs.length;
  hosts.srv_4.extra.hello = async () =>
    HelloResponse.fromPartial({
      agentVersion: "0.0.1",
      capabilities: hosts.srv_4.capabilities,
    });
  pin("0.3.0");

  await runClusterRollout();

  // The agent is what installs and restarts the binary: the agent rollout goes first, and says so itself.
  assert.equal(hosts.srv_4.installs.length, before);
  assert.deepEqual(await updateRows(), []);
  assert.equal(hosts[SERVER_1].status.version, "0.3.0");

  delete hosts.srv_4.extra.hello;
  await runClusterRollout();
  assert.equal(hosts.srv_4.status.version, "0.3.0");
});

test("with no cluster release pinned, nothing is asked of any server", async () => {
  await euLedFromSrv4();
  __setClusterPinForTest(null);
  const opened = Object.values(hosts).map((h) => h.opened.length);

  await runClusterRollout();

  assert.deepEqual(
    Object.values(hosts).map((h) => h.opened.length),
    opened,
  );
});

test("a failed update is kept, said once, shown on the cluster card and retried after a wait that grows", async () => {
  const cluster = await euLedFromSrv4();
  let refuse = true;
  const real = hosts.srv_4.installs;
  hosts.srv_4.extra.installCluster = async (version, _b, relay) => {
    if (refuse) throw new Error("no space left on device");
    real.push({ version, relay, urls: [] });
    hosts.srv_4.status = { ...hosts.srv_4.status, version };
    return { version, running: true };
  };
  pin("0.3.0");

  await runClusterRollout();

  let [row] = await updateRows();
  assert.equal(row.serverId, "srv_4");
  assert.equal(row.attempts, 1);
  assert.equal(row.targetVersion, "0.3.0");
  assert.match(row.lastError, /no space left on device/);
  const firstRetry = Date.parse(row.nextRetryAt!);
  assert.ok(firstRetry > Date.now() + 30_000);
  // One server's trouble is its own: Deplo's machine still updates.
  assert.equal(hosts[SERVER_1].status.version, "0.3.0");
  const said = (await byDeplo()).filter((m) => /srv_4/.test(m));
  assert.deepEqual(said, [
    "Deplo: Could not update the cluster leader and relay on srv_4 to v0.3.0: no space left on device. Deplo retries on its own.",
  ]);
  const card = await asAdmin(() => getClusterLeader(cluster.id));
  assert.equal(
    card.updateMessage,
    "Deplo could not update the leader on srv_4 to v0.3.0: no space left on device. It retries on its own.",
  );

  // Not due yet: nothing is tried, nothing is said again.
  await runClusterRollout();
  [row] = await updateRows();
  assert.equal(row.attempts, 1);

  // Due, and it fails again: the wait doubles, Activity stays at one entry.
  const due = { nextRetryAt: new Date(Date.now() - 1000).toISOString() };
  await db.update(clusterBinaryUpdates).set(due);
  await runClusterRollout();
  [row] = await updateRows();
  assert.equal(row.attempts, 2);
  assert.ok(Date.parse(row.nextRetryAt!) - Date.now() > 90_000);
  assert.equal((await byDeplo()).filter((m) => /Could not/.test(m)).length, 1);

  // The row is all the next pass needs, so a restarted Deplo picks it up: due again, and this time it works.
  refuse = false;
  await db.update(clusterBinaryUpdates).set(due);
  await runClusterRollout();
  assert.deepEqual(await updateRows(), []);
  assert.equal(hosts.srv_4.status.version, "0.3.0");
  assert.equal(
    (await asAdmin(() => getClusterLeader(cluster.id))).updateMessage,
    "",
  );
});

test("a leader that took the new binary and did not come back stops the rollout before the next server", async () => {
  await euLedFromSrv4();
  hosts.srv_4.extra.installCluster = async (version) => {
    hosts.srv_4.status = { ...hosts.srv_4.status, version, running: false };
    return { version, running: true };
  };
  pin("0.3.0");

  await runClusterRollout();

  const [row] = await updateRows();
  assert.equal(row.failure, "no_return");
  // A release that breaks one leader must not break the one that stands in for it.
  assert.equal(hosts[SERVER_1].status.version, "0.2.0");
  assert.deepEqual(await byDeplo(), [
    "Deplo: Could not update the cluster leader and relay on srv_4 to v0.3.0: It took the new version but did not start on it. The other servers wait until it does. Deplo retries on its own.",
  ]);
});

test("a leader is not restarted while a server of its cluster is not answering", async () => {
  const cluster = await euLedFromSrv4();
  await db
    .update(clusterMembers)
    .set({
      leaseState: "not_responding",
      leaseChangedAt: new Date().toISOString(),
    })
    .where(eq(clusterMembers.serverId, "srv_2"));
  const before = hosts.srv_4.installs.length;
  pin("0.3.0");

  await runClusterRollout();

  assert.equal(hosts.srv_4.installs.length, before);
  const [row] = await updateRows();
  assert.equal(row.failure, "busy");
  assert.equal(
    (await asAdmin(() => getClusterLeader(cluster.id))).updateMessage,
    "Deplo could not update the leader on srv_4 to v0.3.0: A server of cluster eu is not answering, and a leader is not restarted while its Apps may be moving. It retries on its own.",
  );
  // Deplo's own machine leads nothing right now, so nothing holds its update.
  assert.equal(hosts[SERVER_1].status.version, "0.3.0");
});

test("a frozen Deplo updates nothing", async () => {
  await euLedFromSrv4();
  pin("0.3.0");
  await db.insert(deploMoves).values({
    id: "dmv_1",
    side: "target",
    state: "copying",
    schedulesPaused: false,
    startedBy: USER_1,
    peerUrl: "https://old.example.com",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  invalidateFrozen();

  await runClusterRollout();

  assert.equal(hosts.srv_4.status.version, "0.2.0");
  assert.equal(hosts[SERVER_1].status.version, "0.2.0");
});

test("a leader below the minimum hands the cluster to Deplo's machine until it is updated, then leads again", async () => {
  const cluster = await euLedFromSrv4();
  assert.equal((await stored(cluster.id)).epoch, 2);
  // This Deplo no longer accepts v0.2.0. Its own machine is updated first here, as a new panel's would be.
  hosts[SERVER_1].status = { ...hosts[SERVER_1].status, version: "0.3.0" };
  pin("0.3.0", "0.3.0");
  let refuse = true;
  hosts.srv_4.extra.installCluster = async (version) => {
    if (refuse) throw new Error("GitHub did not answer");
    hosts.srv_4.status = { ...hosts.srv_4.status, version };
    return { version, running: true };
  };

  await runClusterRollout();
  const card = await asAdmin(() => getClusterLeader(cluster.id));
  assert.equal(card.state, "outdated");
  assert.equal(
    card.message,
    "This leader is older than this Deplo accepts. Deplo updates it on its own.",
  );
  await superviseClusterLeader(cluster.id);
  assert.equal(await superviseClusterLeader(cluster.id), "taken_over");
  assert.deepEqual(await stored(cluster.id), {
    server: "srv_4",
    takenOver: true,
    epoch: 3,
  });
  assert.equal(leaders[SERVER_1].rosters.at(-1)!.epoch, 3);

  // Still too old: Deplo's machine keeps leading.
  assert.equal(await superviseClusterLeader(cluster.id), null);

  refuse = false;
  await db
    .update(clusterBinaryUpdates)
    .set({ nextRetryAt: new Date(Date.now() - 1000).toISOString() });
  await runClusterRollout();
  assert.equal(await superviseClusterLeader(cluster.id), "handed_back");
  assert.deepEqual(await stored(cluster.id), {
    server: "srv_4",
    takenOver: false,
    epoch: 4,
  });
  assert.equal(leaders.srv_4.rosters.at(-1)!.epoch, 4);

  assert.deepEqual(await byDeplo(), [
    "Deplo: Could not update the cluster leader and relay on srv_4 to v0.3.0: GitHub did not answer. Deplo retries on its own.",
    "Deplo: The leader on srv_4 is older than this Deplo accepts, so Deplo's machine leads cluster eu until it is updated",
    "Deplo: Updated the cluster leader and relay on srv_4 to v0.3.0",
    "Deplo: srv_4 answers again, so it leads cluster eu again",
  ]);
});
