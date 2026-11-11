import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { TestDb } from "../db/test-harness";
import { TEAM_B, USER_1 } from "./identity-test-helpers";
import { SERVER_1 } from "./app-graph-test-helpers";
import { clusterLeaderKeys } from "../db/schema/control-plane/clusters";
import { deploMoves } from "../db/schema/control-plane/deplo-move";
import type { FakeClusterHost } from "../infra/agent-client/cluster-test-helpers";
import { getClusterLeader } from "./clusters/leader";
import { forgetLeaderRoster } from "./clusters/leader-sync";
import { moveClusterLeader } from "./clusters/leader-move";
import {
  leadClustersAfterMove,
  superviseClusterLeader,
} from "./clusters/leader-standby";
import { listClusterMembers } from "./clusters/members";
import { applyLeaderEvent, watchClusterOnce } from "./clusters/watch";
import {
  __resetClusterWatchForTest,
  releaseClusterWatchLease,
  runClusterWatchTick,
} from "./clusters/watch-scheduler";
import { getClusterById } from "./clusters/roster";
import { keyFingerprint } from "./clusters/bundles";
import { invalidateFrozen } from "./deplo-move/freeze";
import {
  leaderLab,
  newTestLeader,
  openBundle,
  relayRosters,
  type TestLeader,
} from "./cluster-leader-test-helpers";

const lab = leaderLab();
const { asAdmin, eu, messages, clusterApp, deployed } = lab;
const { keyOwners, pushedTo, stored } = lab;

let db: TestDb;
let hosts: Record<string, FakeClusterHost>;
let leaders: Record<string, TestLeader>;
beforeEach(() => {
  ({ db, hosts, leaders } = lab);
});

test("Deplo's machine leads while the leader's server is away, and each change of hands raises the epoch", async () => {
  const cluster = await eu();
  await asAdmin(() => moveClusterLeader(cluster.id, "srv_4"));
  assert.equal(await superviseClusterLeader(cluster.id), null);
  assert.deepEqual(await stored(cluster.id), {
    server: "srv_4",
    takenOver: false,
    epoch: 2,
  });

  // One missed check is a blip; the second one is an outage.
  hosts.srv_4.unreachable = true;
  assert.equal(await superviseClusterLeader(cluster.id), null);
  assert.equal(await superviseClusterLeader(cluster.id), "taken_over");
  assert.deepEqual(await stored(cluster.id), {
    server: "srv_4",
    takenOver: true,
    epoch: 3,
  });
  const own = leaders[SERVER_1].rosters.at(-1)!;
  assert.equal(own.epoch, 3);
  assert.deepEqual(
    own.members.map((m) => m.id),
    ["srv_2", "srv_3"],
  );
  const away = await asAdmin(() => getClusterLeader(cluster.id));
  assert.equal(away.serverId, "srv_4");
  assert.equal(away.state, "unreachable");
  assert.ok(away.takenOverAt);

  // Still away: nothing more happens, and the epoch stays.
  assert.equal(await superviseClusterLeader(cluster.id), null);
  assert.equal((await stored(cluster.id)).epoch, 3);

  // It returns holding the epoch it left with; it is handed a newer one, never the one Deplo's machine led with.
  hosts.srv_4.unreachable = false;
  assert.equal(leaders.srv_4.epochs.get(cluster.id), 2);
  assert.equal(await superviseClusterLeader(cluster.id), "handed_back");
  assert.deepEqual(await stored(cluster.id), {
    server: "srv_4",
    takenOver: false,
    epoch: 4,
  });
  assert.equal(leaders.srv_4.rosters.at(-1)!.epoch, 4);
  assert.equal(leaders[SERVER_1].epochs.get(cluster.id), 3);
  assert.equal(
    (await asAdmin(() => getClusterLeader(cluster.id))).takenOverAt,
    null,
  );

  const said = (await messages()).filter((m) => m.startsWith("Deplo: "));
  assert.deepEqual(said, [
    "Deplo: srv_4 stopped answering, so Deplo's machine leads cluster eu until it answers again",
    "Deplo: srv_4 answers again, so it leads cluster eu again",
  ]);
  // The team of the admin who moved the leader reads it, not whichever team is oldest.
  assert.deepEqual(
    (await messages(TEAM_B)).filter((m) => m.startsWith("Deplo: ")),
    [],
  );
});

test("a leader below the version Deplo accepts counts as away", async () => {
  const cluster = await eu();
  await asAdmin(() => moveClusterLeader(cluster.id, "srv_4"));
  hosts.srv_4.status = { ...hosts.srv_4.status, version: "0.1.0" };
  await superviseClusterLeader(cluster.id);
  assert.equal(await superviseClusterLeader(cluster.id), "taken_over");
});

test("with Deplo's own leader down too, nothing is taken over and the epoch stays", async () => {
  const cluster = await eu();
  await asAdmin(() => moveClusterLeader(cluster.id, "srv_4"));
  hosts.srv_4.unreachable = true;
  hosts[SERVER_1].unreachable = true;
  await superviseClusterLeader(cluster.id).catch(() => null);
  await assert.rejects(superviseClusterLeader(cluster.id));
  assert.deepEqual(await stored(cluster.id), {
    server: "srv_4",
    takenOver: false,
    epoch: 2,
  });
});

test("a cluster led from Deplo's machine is never checked, and a frozen Deplo takes nothing over", async () => {
  const cluster = await eu();
  const opened = hosts[SERVER_1].opened.length;
  assert.equal(await superviseClusterLeader(cluster.id), null);
  assert.equal(hosts[SERVER_1].opened.length, opened);

  await asAdmin(() => moveClusterLeader(cluster.id, "srv_4"));
  hosts.srv_4.unreachable = true;
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
  for (let i = 0; i < 3; i++)
    assert.equal(await superviseClusterLeader(cluster.id), null);
  assert.equal((await stored(cluster.id)).takenOver, false);
});

test("the bundle a returning leader missed is sent when it leads again", async () => {
  const cluster = await eu();
  const app = await clusterApp(cluster.id);
  await asAdmin(() => moveClusterLeader(cluster.id, "srv_4"));
  hosts.srv_4.unreachable = true;
  await superviseClusterLeader(cluster.id);
  await superviseClusterLeader(cluster.id);

  // Deployed while it was away: the leader that leads has it, so nothing says the App cannot fail over.
  await deployed(app, "dpl_1");
  assert.equal(
    (await openBundle(leaders[SERVER_1], app.id)).deploymentId,
    "dpl_1",
  );
  assert.equal(leaders.srv_4.held.has(app.id), false);
  assert.deepEqual(
    (await messages()).filter((m) => /fail over/.test(m)),
    [],
  );

  hosts.srv_4.unreachable = false;
  await superviseClusterLeader(cluster.id);
  assert.equal((await openBundle(leaders.srv_4, app.id)).deploymentId, "dpl_1");
});

test("the watch follows whichever leader leads, from that leader's newest event", async () => {
  const cluster = await eu();
  await asAdmin(() => moveClusterLeader(cluster.id, "srv_4"));
  // What Deplo's own leader said when it last led is old news.
  hosts[SERVER_1].watch.push("member_state", cluster.id, {
    member: "srv_2",
    state: "fenced",
  });
  leaders[SERVER_1].head = 1;
  hosts.srv_4.unreachable = true;
  await superviseClusterLeader(cluster.id);
  await superviseClusterLeader(cluster.id);

  const done = watchClusterOnce(cluster.id);
  for (let i = 0; i < 100 && hosts[SERVER_1].watch.opens.length === 0; i++)
    await new Promise((r) => setTimeout(r, 10));
  await new Promise((r) => setTimeout(r, 50));
  hosts[SERVER_1].watch.drop();
  await done;

  assert.deepEqual(hosts[SERVER_1].watch.opens, [1]);
  assert.deepEqual(hosts.srv_4.watch.opens, []);
  const members = await asAdmin(() => listClusterMembers(cluster.id));
  assert.deepEqual(
    members.map((m) => m.leaseState),
    ["ok", "ok"],
  );
});

test("an older epoch a leader reports never lowers the stored one", async () => {
  const cluster = await eu();
  await asAdmin(() => moveClusterLeader(cluster.id, "srv_4"));
  const seq = (await getClusterById(cluster.id))!.eventSeq + 1;
  await applyLeaderEvent(cluster.id, {
    seq,
    type: "epoch",
    cluster: cluster.id,
    data: { epoch: 1 },
  });
  assert.equal((await stored(cluster.id)).epoch, 2);
  await applyLeaderEvent(cluster.id, {
    seq: seq + 1,
    type: "epoch",
    cluster: cluster.id,
    data: { epoch: 5 },
  });
  assert.equal((await stored(cluster.id)).epoch, 5);
});

const until = async (ok: () => boolean) => {
  for (let i = 0; i < 200 && !ok(); i++)
    await new Promise((r) => setTimeout(r, 10));
  assert.ok(ok(), "timed out");
};

test("the background pass takes over on its own and moves the watch to the leader that leads", async () => {
  const cluster = await eu();
  await asAdmin(() => moveClusterLeader(cluster.id, "srv_4"));
  try {
    await runClusterWatchTick();
    await until(() => hosts.srv_4.watch.opens.length === 1);
    assert.deepEqual(hosts[SERVER_1].watch.opens, []);

    hosts.srv_4.unreachable = true;
    hosts.srv_4.watch.drop();
    await runClusterWatchTick();
    assert.equal((await stored(cluster.id)).takenOver, false);
    await runClusterWatchTick();
    assert.equal((await stored(cluster.id)).takenOver, true);
    await until(() => hosts[SERVER_1].watch.opens.length === 1);

    hosts.srv_4.unreachable = false;
    await runClusterWatchTick();
    assert.deepEqual(await stored(cluster.id), {
      server: "srv_4",
      takenOver: false,
      epoch: 4,
    });
    await until(() => hosts.srv_4.watch.opens.length === 2);
  } finally {
    __resetClusterWatchForTest();
    for (const h of Object.values(hosts)) h.watch.drop();
    await releaseClusterWatchLease();
  }
});

// What a Deplo move leaves on the new machine: the copied rows, no leader keys, and an agent that never ran a leader.
async function movedToANewMachine() {
  await db.delete(clusterLeaderKeys);
  const old = leaders[SERVER_1];
  const fresh = (leaders[SERVER_1] = await newTestLeader());
  hosts[SERVER_1].leader = fresh.calls;
  hosts[SERVER_1].status = { ...hosts[SERVER_1].status, installed: false };
  hosts[SERVER_1].installs.length = 0;
  forgetLeaderRoster();
  return { old, fresh };
}

test("after a Deplo move the new machine's leader is started, leads from a newer epoch and gets every bundle sealed for it", async () => {
  const cluster = await eu();
  const app = await clusterApp(cluster.id);
  await deployed(app, "dpl_1");
  const before = (await stored(cluster.id)).epoch;
  const { old, fresh } = await movedToANewMachine();

  await leadClustersAfterMove();

  assert.equal(hosts[SERVER_1].installs.length, 1);
  assert.equal(hosts[SERVER_1].installs[0].relay, true);
  // The old machine's leader may still run: this one is never given its epoch.
  const epoch = Math.max(before, 1) + 1;
  assert.equal((await stored(cluster.id)).epoch, epoch);
  assert.equal(fresh.rosters.at(-1)!.epoch, epoch);

  const bundle = await openBundle(fresh, app.id);
  assert.equal(bundle.deploymentId, "dpl_1");
  assert.equal(bundle.stack.env.API_KEY, "k-123");
  await assert.rejects(openBundle({ ...old, held: fresh.held }, app.id));
  assert.deepEqual(await keyOwners(cluster.id), { deplo: fresh.publicKey });
  assert.deepEqual(await pushedTo(app.id), [keyFingerprint(fresh.publicKey)]);
  assert.deepEqual(
    relayRosters(hosts[SERVER_1])
      .at(-1)!
      .parties.map((p) => p.role),
    ["leader", "member", "member"],
  );
});

test("after a Deplo move a leader on another server keeps leading, and the new machine stands by with its own key", async () => {
  const cluster = await eu();
  const app = await clusterApp(cluster.id);
  await asAdmin(() => moveClusterLeader(cluster.id, "srv_4"));
  await deployed(app, "dpl_1");
  const { fresh } = await movedToANewMachine();

  await leadClustersAfterMove();

  assert.deepEqual(await stored(cluster.id), {
    server: "srv_4",
    takenOver: false,
    epoch: 2,
  });
  assert.deepEqual(await keyOwners(cluster.id), {
    srv_4: leaders.srv_4.publicKey,
    deplo: fresh.publicKey,
  });
  for (const l of [fresh, leaders.srv_4])
    assert.equal((await openBundle(l, app.id)).deploymentId, "dpl_1");
});
