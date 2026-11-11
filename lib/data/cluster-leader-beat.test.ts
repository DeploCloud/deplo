import { test, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { TestDb } from "../db/test-harness";
import { SERVER_1 } from "./app-graph-test-helpers";
import { USER_1 } from "./identity-test-helpers";
import { deploMoves } from "../db/schema/control-plane/deplo-move";
import type { FakeClusterHost } from "../infra/agent-client/cluster-test-helpers";
import {
  __setLeaderBeatClockForTest,
  beatClusterLeaders,
  TAKEOVER_AFTER_MS,
} from "./clusters/leader-beat";
import { moveClusterLeader } from "./clusters/leader-move";
import { superviseClusterLeader } from "./clusters/leader-standby";
import { createCluster } from "./clusters/manage";
import {
  __resetClusterWatchForTest,
  releaseClusterWatchLease,
  runClusterBeat,
  runClusterWatchTick,
} from "./clusters/watch-scheduler";
import { invalidateFrozen } from "./deplo-move/freeze";
import { leaderLab } from "./cluster-leader-test-helpers";

const lab = leaderLab();
const { asAdmin, eu, stored } = lab;

let db: TestDb;
let hosts: Record<string, FakeClusterHost>;
beforeEach(() => {
  ({ db, hosts } = lab);
});
afterEach(() => __setLeaderBeatClockForTest(null));

/** Every beat the leader on a host was sent, through that host's agent. */
const beats = (h: FakeClusterHost) =>
  h.calls
    .filter((c) => c.method === "leader.beat")
    .map(
      (c) =>
        (
          JSON.parse(new TextDecoder().decode(c.payload)) as {
            epochs: Record<string, number>;
          }
        ).epochs,
    );

test("Deplo names each cluster's epoch to the leader that leads it, through that server's agent", async () => {
  const cluster = await eu();
  const other = await asAdmin(() =>
    createCluster("us", { allTeams: true, teamIds: [] }),
  );
  await beatClusterLeaders();
  // One call carries every cluster a leader leads.
  assert.deepEqual(beats(hosts[SERVER_1]), [
    { [cluster.id]: 1, [other.id]: 1 },
  ]);

  await asAdmin(() => moveClusterLeader(cluster.id, "srv_4"));
  hosts[SERVER_1].calls.length = 0;
  hosts.srv_4.calls.length = 0;
  await beatClusterLeaders();
  assert.deepEqual(beats(hosts.srv_4), [{ [cluster.id]: 2 }]);
  assert.deepEqual(beats(hosts[SERVER_1]), [{ [other.id]: 1 }]);
});

test("a leader Deplo named a moment ago is given 25 s before Deplo's machine leads in its place", async () => {
  const cluster = await eu();
  await asAdmin(() => moveClusterLeader(cluster.id, "srv_4"));
  let now = 1_000_000;
  __setLeaderBeatClockForTest(() => now);
  await beatClusterLeaders();

  // It may still lead its half on that word: two missed checks are not enough yet.
  hosts.srv_4.unreachable = true;
  await beatClusterLeaders();
  for (let i = 0; i < 3; i++)
    assert.equal(await superviseClusterLeader(cluster.id), null);
  now += TAKEOVER_AFTER_MS - 1;
  assert.equal(await superviseClusterLeader(cluster.id), null);
  assert.equal((await stored(cluster.id)).takenOver, false);
  now += 1;
  assert.equal(await superviseClusterLeader(cluster.id), "taken_over");

  // From now on the word goes to Deplo's own leader, at the epoch it leads with.
  hosts.srv_4.unreachable = false;
  hosts.srv_4.calls.length = 0;
  await beatClusterLeaders();
  assert.deepEqual(beats(hosts[SERVER_1]).at(-1), { [cluster.id]: 3 });
  assert.deepEqual(beats(hosts.srv_4), []);
});

test("a beat that left and got no answer may have been heard, and one that never left was not", async () => {
  const cluster = await eu();
  await asAdmin(() => moveClusterLeader(cluster.id, "srv_4"));
  let now = 1_000_000;
  __setLeaderBeatClockForTest(() => now);
  await beatClusterLeaders();

  // The leader takes the beat and its answer is lost: it leads on that word for as long as on an answered one.
  const answers = hosts.srv_4.leader;
  hosts.srv_4.leader = () => {
    throw new Error("the answer was lost");
  };
  now += 5_000;
  await beatClusterLeaders();
  hosts.srv_4.leader = answers;
  hosts.srv_4.unreachable = true;
  // Its server is gone now: these never leave.
  now += 5_000;
  await beatClusterLeaders();
  await superviseClusterLeader(cluster.id);
  now += TAKEOVER_AFTER_MS - 5_000 - 1;
  assert.equal(await superviseClusterLeader(cluster.id), null);
  now += 1;
  assert.equal(await superviseClusterLeader(cluster.id), "taken_over");
});

test("a Deplo that just started does not know when the leader was last named, so it waits as long", async () => {
  const cluster = await eu();
  await asAdmin(() => moveClusterLeader(cluster.id, "srv_4"));
  let now = 5_000_000;
  __setLeaderBeatClockForTest(() => now);
  hosts.srv_4.unreachable = true;
  assert.equal(await superviseClusterLeader(cluster.id), null);
  assert.equal(await superviseClusterLeader(cluster.id), null);
  now += TAKEOVER_AFTER_MS;
  assert.equal(await superviseClusterLeader(cluster.id), "taken_over");
});

test("the leader a cluster is taken from is told the newer epoch, so it stops at once", async () => {
  const cluster = await eu();
  await asAdmin(() => moveClusterLeader(cluster.id, "srv_4"));
  // Deplo's own leader led until the move.
  assert.deepEqual(beats(hosts[SERVER_1]), [{ [cluster.id]: 2 }]);

  hosts.srv_4.unreachable = true;
  await superviseClusterLeader(cluster.id);
  assert.equal(await superviseClusterLeader(cluster.id), "taken_over");
  hosts.srv_4.unreachable = false;
  hosts[SERVER_1].calls.length = 0;
  assert.equal(await superviseClusterLeader(cluster.id), "handed_back");
  assert.deepEqual(beats(hosts[SERVER_1]), [{ [cluster.id]: 4 }]);

  // A person moves it on: the server it leaves hears the epoch of the one that leads now.
  hosts.srv_4.calls.length = 0;
  await asAdmin(() => moveClusterLeader(cluster.id, "srv_3"));
  assert.deepEqual(beats(hosts.srv_4), [{ [cluster.id]: 5 }]);
});

test("a frozen Deplo names nobody, and only the Deplo that holds the watch does", async () => {
  const cluster = await eu();
  try {
    await runClusterBeat();
    assert.deepEqual(beats(hosts[SERVER_1]), []);
    await runClusterWatchTick();
    await runClusterBeat();
    assert.deepEqual(beats(hosts[SERVER_1]), [{ [cluster.id]: 1 }]);

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
    await beatClusterLeaders();
    await runClusterWatchTick();
    await runClusterBeat();
    assert.equal(beats(hosts[SERVER_1]).length, 1);
  } finally {
    __resetClusterWatchForTest();
    for (const h of Object.values(hosts)) h.watch.drop();
    await releaseClusterWatchLease();
  }
});
