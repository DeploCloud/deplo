import { __forgetGone } from "./clusters/gone";
import { test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { SERVER_1 } from "./app-graph-test-helpers";
import { activities } from "../db/schema/control-plane/activity";
import {
  clusterMembers,
  clusters as clustersTable,
} from "../db/schema/control-plane/clusters";
import { addClusterMember, listClusterMembers } from "./clusters/members";
import { applyLeaderEvent } from "./clusters/watch";
import {
  db,
  leader,
  setSnapshot,
  watchFixture,
  asAdmin,
  asTeamB,
  eu,
  states,
  activityTexts,
  watchUntil,
} from "./cluster-watch-test-helpers";

watchFixture();

test("a leader that hears too few servers is never read as each server going silent", async () => {
  const cluster = await eu();
  await asAdmin(() => addClusterMember(cluster.id, SERVER_1));
  const said = (member: string, state: string) =>
    leader.watch.push("member_state", cluster.id, { member, state });
  // srv_2 stops; then srv_3 does, and the leader, left hearing one of three, stops counting on the last one too.
  said("srv_2", "not_responding");
  said("srv_3", "not_responding");
  said(SERVER_1, "not_responding");
  said(SERVER_1, "fenced");
  await watchUntil(cluster.id, 4);

  assert.deepEqual(await activityTexts(), [
    "srv_2 is not responding in cluster eu.",
    "Too few servers answer in cluster eu, so nothing moves and srv_3 no longer counts as answering.",
    `Too few servers answer in cluster eu, so nothing moves and ${SERVER_1} no longer counts as answering.`,
    `Too few servers answer in cluster eu. ${SERVER_1} runs no database or App that must never run twice, so nothing on it had to stop.`,
  ]);
});

test("a leader that says it leads is never written as hearing too few, whatever the stored states say", async () => {
  const cluster = await eu();
  await asAdmin(() => addClusterMember(cluster.id, SERVER_1));
  setSnapshot({
    head: 0,
    clusters: { [cluster.id]: { epoch: 1, leads: true } },
  });
  leader.watch.push("member_state", cluster.id, {
    member: "srv_2",
    state: "not_responding",
  });
  leader.watch.push("member_state", cluster.id, {
    member: "srv_3",
    state: "not_responding",
  });
  await watchUntil(cluster.id, 2);
  assert.deepEqual(await activityTexts(), [
    "srv_2 is not responding in cluster eu.",
    "srv_3 is not responding in cluster eu.",
  ]);
});

test("Deplo's machine standing in says which servers it hears, and that the others are off or cut off", async () => {
  const cluster = await eu();
  await asAdmin(() => addClusterMember(cluster.id, SERVER_1));
  await db
    .update(clustersTable)
    .set({
      leaderServerId: "srv_2",
      leaderTakeoverAt: new Date().toISOString(),
    })
    .where(eq(clustersTable.id, cluster.id));
  leader.watch.push("member_state", cluster.id, {
    member: "srv_2",
    state: "not_responding",
  });
  await watchUntil(cluster.id, 1);
  const said = (await db.select().from(activities)).map((a) => a.message);
  assert.ok(
    said.includes(
      `Deplo's machine, standing in as the leader of cluster eu, hears ${[SERVER_1, "srv_3"].sort().join(" and ")}: srv_2 is off, or cut off from it.`,
    ),
    said.join("\n"),
  );
  assert.ok(!said.some((m) => /not responding|Too few/.test(m)));
});

test("the cluster card reads the not-responding state for an instance admin; a team the cluster is not shared with sees nothing", async () => {
  const cluster = await eu(false);
  await applyLeaderEvent(cluster.id, {
    seq: 1,
    type: "member_state",
    cluster: cluster.id,
    data: { member: "srv_3", state: "not_responding" },
  });
  assert.deepEqual(await states(cluster.id), {
    srv_2: "ok",
    srv_3: "not_responding",
  });
  assert.deepEqual(await asTeamB(() => listClusterMembers(cluster.id)), []);
  const [row] = await db
    .select()
    .from(clusterMembers)
    .where(eq(clusterMembers.serverId, "srv_3"));
  assert.ok(row.leaseChangedAt, "it says when the state changed");
});

test("a member gone past the grace no longer counts, so the next one to stop is not too few (ADR-0049)", async () => {
  __forgetGone();
  const cluster = await eu();
  await asAdmin(() => addClusterMember(cluster.id, SERVER_1));
  leader.watch.push("member_state", cluster.id, {
    member: "srv_3",
    state: "not_responding",
  });
  leader.watch.push("member_gone", cluster.id, { member: "srv_3" });
  leader.watch.push("member_state", cluster.id, {
    member: "srv_2",
    state: "not_responding",
  });
  await watchUntil(cluster.id, 3);
  // Two of three answer while srv_3 counts: with it gone, one of two is enough with Deplo's word.
  const said = await activityTexts();
  assert.ok(
    said.includes("srv_2 is not responding in cluster eu."),
    said.join(" | "),
  );
  assert.ok(!said.some((t) => t.startsWith("Too few")), said.join(" | "));
  __forgetGone();
});

test("a leader that has not heard a server never makes it answer again, nor a fenced one not responding", async () => {
  const cluster = await eu();
  await db
    .update(clusterMembers)
    .set({ leaseState: "fenced" })
    .where(eq(clusterMembers.serverId, "srv_3"));
  setSnapshot({
    head: 0,
    clusters: {
      [cluster.id]: {
        epoch: 1,
        superseded: false,
        members: [
          { id: "srv_2", state: "ok", heard: true },
          { id: "srv_3", state: "ok", heard: false },
        ],
      },
    },
  });
  await watchUntil(cluster.id, 0);
  assert.equal((await states(cluster.id))["srv_3"], "fenced");
  await applyLeaderEvent(cluster.id, {
    seq: 1,
    type: "member_state",
    cluster: cluster.id,
    data: { member: "srv_3", state: "not_responding" },
  });
  assert.equal((await states(cluster.id))["srv_3"], "fenced");
  const said = await activityTexts();
  assert.ok(
    !said.some((t) => /answers again|not responding/.test(t)),
    said.join(" | "),
  );
});
