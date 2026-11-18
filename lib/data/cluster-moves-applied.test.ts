import { test } from "node:test";
import assert from "node:assert/strict";

import { eq } from "drizzle-orm";

import { clusters as clustersTable } from "../db/schema/control-plane/clusters";
import {
  MoveBatch,
  pauseUnlessLeaderMoves,
  reconcileCluster,
} from "./clusters/watch";
import {
  DOWN_LINK_WAIT_MS,
  declareServerDown,
  serverDeclaredDown,
} from "../infra/agent-client/channel-pool";
import { setMemberLease } from "./clusters/leader-sync";
import { failoverLab } from "./cluster-failover-test-helpers";

// deplo#244: Deplo applies the leader's moves fast, and says what became of every one.
const lab = failoverLab();
const { eu, web, placedOn, event, apply, messages, leaderMoved } = lab;

const moved = async () =>
  (await messages())
    .map((m) => m.message)
    .filter((m) => /^(Moved|Did not move) /.test(m));

test("a move a newer placement replaced is said as superseded, and the App stays where it is placed", async () => {
  const cluster = await eu();
  lab.seq = 0;
  await web(cluster.id);
  await apply(
    cluster.id,
    event(cluster.id, "placement", {
      kind: "app",
      workloadId: "prj_web",
      members: ["srv_2"],
      epoch: 3,
    }),
    event(cluster.id, "failed_over", {
      kind: "app",
      workloadId: "prj_web",
      from: "srv_2",
      to: "srv_3",
      reason: "stopped_answering",
    }),
  );
  assert.deepEqual(await placedOn(), ["srv_2"]);
  assert.deepEqual(await moved(), [
    "Did not move web to server-3: the cluster's leader placed it on server-2 since",
  ]);
  assert.equal(lab.members.srv_3.reroutes.length, 0, "nothing re-routed");
});

test("a move Deplo never read, because the leader that made it is gone, is said once the next leader's picture shows it", async () => {
  const cluster = await eu();
  await web(cluster.id);
  // No range was dropped from this leader's events: the move came from the leader before it.
  leaderMoved(cluster.id, [{ id: "prj_web", member: "srv_3", seq: 2 }]);
  await reconcileCluster(cluster.id, null);
  assert.deepEqual(await placedOn(), ["srv_3"]);
  assert.deepEqual(await moved(), [
    "Moved web to server-3: server-2 stopped answering",
  ]);
  // Read again, the picture changes nothing and says nothing twice.
  await reconcileCluster(cluster.id, null);
  assert.equal((await moved()).length, 1);
});

test("independent moves are applied side by side, each workload's in order, and the sequence moves once all are done", async () => {
  const cluster = await eu();
  lab.seq = 0;
  const log: string[] = [];
  const storedSeq = async () =>
    (
      await lab.db
        .select({ seq: clustersTable.eventSeq })
        .from(clustersTable)
        .where(eq(clustersTable.id, cluster.id))
    )[0].seq;
  const batch = new MoveBatch(cluster.id, async (_id, e) => {
    const name = `${String(e.data.workloadId)}#${e.seq}`;
    log.push(`start ${name}`);
    await new Promise((r) =>
      setTimeout(r, e.data.workloadId === "prj_a" ? 40 : 5),
    );
    log.push(`end ${name}`);
    return "applied";
  });
  const ev = (id: string) =>
    event(cluster.id, "failed_over", {
      kind: "app",
      workloadId: id,
      from: "srv_2",
      to: "srv_3",
    });
  const a1 = ev("prj_a");
  const b1 = ev("prj_b");
  const a2 = ev("prj_a");
  batch.add(a1);
  batch.add(b1);
  batch.add(a2);
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(log.includes(`end prj_b#${b1.seq}`), "b waited for a");
  assert.ok(!log.includes(`end prj_a#${a1.seq}`));
  assert.equal(
    await storedSeq(),
    0,
    "the sequence moved before every move ended",
  );
  await batch.settle();
  assert.ok(
    log.indexOf(`start prj_a#${a2.seq}`) > log.indexOf(`end prj_a#${a1.seq}`),
    `the second move of prj_a overlapped the first: ${log.join(", ")}`,
  );
  assert.equal(await storedSeq(), a2.seq);
});

test("a server the leader declared down is waited for 1 s, not 10, and its link or an ok clears it", async () => {
  const cluster = await eu();
  await setMemberLease(cluster.id, "srv_2", "not_responding");
  assert.equal(serverDeclaredDown("srv_2"), true);
  assert.equal(DOWN_LINK_WAIT_MS, 1_000);
  await setMemberLease(cluster.id, "srv_2", "ok");
  assert.equal(serverDeclaredDown("srv_2"), false);
  await setMemberLease(cluster.id, "srv_2", "fenced");
  assert.equal(serverDeclaredDown("srv_2"), true);
  declareServerDown("srv_2", false);
});

test("a watch waiting out its pause looks again as soon as another server leads the cluster", async () => {
  const cluster = await eu();
  await lab.db
    .update(clustersTable)
    .set({ leaderServerId: "srv_2" })
    .where(eq(clustersTable.id, cluster.id));
  const started = Date.now();
  const pausing = pauseUnlessLeaderMoves(
    cluster.id,
    "srv_2",
    30_000,
    new AbortController().signal,
  );
  await new Promise((r) => setTimeout(r, 200));
  // Deplo's machine takes the lead over.
  await lab.db
    .update(clustersTable)
    .set({ leaderServerId: "srv_3" })
    .where(eq(clustersTable.id, cluster.id));
  await pausing;
  const waited = Date.now() - started;
  assert.ok(waited < 2_500, `waited ${waited} ms of a 30 s pause`);
});
