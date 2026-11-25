import { test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { USER_1 } from "./identity-test-helpers";
import { activities } from "../db/schema/control-plane/activity";
import { apps as appsTable } from "../db/schema/control-plane/apps";
import {
  clusters as clustersTable,
  workloadPlacements,
} from "../db/schema/control-plane/clusters";
import { deploMoves } from "../db/schema/control-plane/deplo-move";
import { __setClusterPinForTest } from "../infra/agent-client/cluster-host";
import { invalidateFrozen } from "./deplo-move/freeze";
import { getClusterById } from "./clusters/roster";
import { placementEntries, pushLeaderRoster } from "./clusters/leader-sync";
import {
  applyLeaderEvent,
  parseWatchLine,
  watchClusterOnce,
} from "./clusters/watch";
import {
  db,
  pg,
  leader,
  rosterCalls,
  rosterRefusal,
  enc,
  setSnapshot,
  setRosterRefusal,
  watchFixture,
  eu,
  inCluster,
  stored,
  states,
  activityTexts,
  watchUntil,
} from "./cluster-watch-test-helpers";

watchFixture();

test("watch lines parse: hello, event, ping, and nonsense is dropped", () => {
  const line = (v: unknown) => parseWatchLine(enc(v));
  assert.deepEqual(line({ hello: true, head: 7, gap: true }), {
    kind: "hello",
    head: 7,
    gap: true,
  });
  assert.deepEqual(line({ ping: true }), { kind: "ping" });
  assert.deepEqual(
    line({ seq: 3, type: "epoch", cluster: "clu_1", data: { epoch: 2 } }),
    {
      kind: "event",
      event: { seq: 3, type: "epoch", cluster: "clu_1", data: { epoch: 2 } },
    },
  );
  assert.equal(line({ nothing: 1 }), null);
  assert.equal(parseWatchLine(new TextEncoder().encode("not json")), null);
});

test("events buffered while Deplo was away are applied once, in order, from the stored sequence", async () => {
  const cluster = await eu();
  await inCluster(cluster.id, "prj_web", "srv_2");
  await db.insert(workloadPlacements).values({
    kind: "app",
    workloadId: "prj_web",
    replica: 0,
    memberServerId: "srv_2",
    epoch: 1,
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  // What the leader buffered while the control plane was down.
  leader.watch.push("epoch", cluster.id, { epoch: 2 });
  leader.watch.push("member_state", cluster.id, {
    member: "srv_2",
    state: "not_responding",
  });
  leader.watch.push("member_state", cluster.id, {
    member: "srv_2",
    state: "ok",
  });
  leader.watch.push("placement", cluster.id, {
    kind: "app",
    workloadId: "prj_web",
    members: ["srv_3"],
    epoch: 2,
  });

  assert.equal(await watchUntil(cluster.id, 4), "ended");

  assert.deepEqual(
    leader.watch.opens,
    [0],
    "it asked from the stored sequence",
  );
  assert.deepEqual(await stored(cluster.id), { seq: 4, epoch: 2 });
  const [row] = await db
    .select()
    .from(workloadPlacements)
    .where(eq(workloadPlacements.workloadId, "prj_web"));
  assert.equal(row.memberServerId, "srv_3");
  assert.equal(row.epoch, 2);
  const [app] = await db
    .select()
    .from(appsTable)
    .where(eq(appsTable.id, "prj_web"));
  assert.equal(app.serverId, "srv_3");
  // Two transitions, once each, in the order they happened.
  const texts = await activityTexts();
  assert.equal(texts.length, 2);
  assert.match(texts[0], /is not responding in cluster eu\./);
  assert.match(texts[1], /answers again in cluster eu\./);
});

test("a second watch starts from the stored sequence and applies nothing twice", async () => {
  const cluster = await eu();
  leader.watch.push("member_state", cluster.id, {
    member: "srv_3",
    state: "not_responding",
  });
  leader.watch.push("member_state", cluster.id, {
    member: "srv_3",
    state: "fenced",
  });
  await watchUntil(cluster.id, 2);
  const before = await activityTexts();
  assert.equal(before.filter((m) => m.includes("not responding")).length, 1);
  assert.equal(
    before.filter((m) => m.includes("stopped responding")).length,
    1,
  );

  leader.watch.push("member_state", cluster.id, {
    member: "srv_3",
    state: "ok",
  });
  await watchUntil(cluster.id, 3);

  assert.deepEqual(leader.watch.opens, [0, 2]);
  const after = await activityTexts();
  assert.equal(after.length, before.length + 1);
  assert.match(after.at(-1)!, /answers again in cluster eu\./);
  assert.deepEqual(await stored(cluster.id), { seq: 3, epoch: 0 });
});

test("an event at or below the stored sequence is skipped, whoever sends it", async () => {
  const cluster = await eu();
  const e = (seq: number, state: string) => ({
    seq,
    type: "member_state",
    cluster: cluster.id,
    data: { member: "srv_2", state },
  });
  assert.equal(
    await applyLeaderEvent(cluster.id, e(5, "not_responding")),
    "applied",
  );
  assert.equal(await applyLeaderEvent(cluster.id, e(5, "ok")), "skipped");
  assert.equal(await applyLeaderEvent(cluster.id, e(4, "ok")), "skipped");
  assert.deepEqual(await states(cluster.id), {
    srv_2: "not_responding",
    srv_3: "ok",
  });
  assert.equal((await stored(cluster.id)).seq, 5);
});

// eu, 24 Nov 2026: "Moved lab-web to eu-3" was written twice at the same instant: when a new server led, a second
// watch read the same event while the first still applied it, and a move moves the sequence only once it settles.
test("one event read by two watches at once is said once", async () => {
  const cluster = await eu();
  const e = {
    seq: 7,
    type: "superseded",
    cluster: cluster.id,
    data: {},
    at: new Date(Date.now() - 1000).toISOString(),
  };
  const both = await Promise.all([
    applyLeaderEvent(cluster.id, e, { advance: false }),
    applyLeaderEvent(cluster.id, e, { advance: false }),
  ]);
  assert.deepEqual(both.sort(), ["applied", "skipped"]);
  assert.equal(
    await applyLeaderEvent(cluster.id, e, { advance: false }),
    "skipped",
  );
  const said = (await db.select().from(activities)).filter((a) =>
    a.message.includes("leader stepped down"),
  );
  assert.equal(said.length, 1);
});

test("the stored epoch and sequence are in the database, so a restart keeps them", async () => {
  const cluster = await eu();
  await applyLeaderEvent(cluster.id, {
    seq: 9,
    type: "epoch",
    cluster: cluster.id,
    data: { epoch: 4 },
  });
  const [row] = await db
    .select()
    .from(clustersTable)
    .where(eq(clustersTable.id, cluster.id));
  assert.equal(row.eventSeq, 9);
  assert.equal(row.leaderEpoch, 4);
  // A process that starts fresh reads them back and asks the leader from there.
  leader.watch.push("epoch", cluster.id, { epoch: 4 });
  await db
    .update(clustersTable)
    .set({ eventSeq: 1 })
    .where(eq(clustersTable.id, cluster.id));
  const done = watchClusterOnce(cluster.id);
  for (let i = 0; i < 100 && leader.watch.opens.length === 0; i++)
    await new Promise((r) => setTimeout(r, 10));
  leader.watch.drop();
  await done;
  assert.deepEqual(leader.watch.opens, [1]);
});

test("another cluster's events on the same leader are not applied here", async () => {
  const cluster = await eu();
  leader.watch.push("member_state", "clu_other", {
    member: "srv_2",
    state: "fenced",
  });
  leader.watch.push("member_state", cluster.id, {
    member: "srv_3",
    state: "not_responding",
  });
  await watchUntil(cluster.id, 2);
  assert.deepEqual(await states(cluster.id), {
    srv_2: "ok",
    srv_3: "not_responding",
  });
});

test("a placement that names a server that left does not hold up what follows", async () => {
  const cluster = await eu();
  await inCluster(cluster.id, "prj_web", "srv_2");
  const warn = console.warn;
  console.warn = () => {};
  try {
    await applyLeaderEvent(cluster.id, {
      seq: 1,
      type: "placement",
      cluster: cluster.id,
      data: {
        kind: "app",
        workloadId: "prj_web",
        members: ["srv_gone"],
        epoch: 1,
      },
    });
  } finally {
    console.warn = warn;
  }
  assert.equal((await stored(cluster.id)).seq, 1);
  assert.equal(
    (await db.select().from(workloadPlacements)).length,
    0,
    "nothing was mirrored",
  );
});

test("a leader that lost its buffer makes the stored sequence start over", async () => {
  const cluster = await eu();
  await db
    .update(clustersTable)
    .set({ eventSeq: 40 })
    .where(eq(clustersTable.id, cluster.id));
  leader.watch.push("epoch", cluster.id, { epoch: 1 });
  assert.equal(await watchClusterOnce(cluster.id), "reset");
  assert.equal((await stored(cluster.id)).seq, 0);
});

test("nothing is applied, and the sequence does not move, while a Deplo move freezes this instance", async () => {
  const cluster = await eu();
  leader.watch.push("member_state", cluster.id, {
    member: "srv_2",
    state: "fenced",
  });
  await db.insert(deploMoves).values({
    id: "dmv_1",
    side: "target",
    state: "copying",
    peerUrl: "https://new.example.com",
    startedBy: USER_1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  invalidateFrozen();
  assert.equal(await watchClusterOnce(cluster.id), "frozen");
  assert.equal((await stored(cluster.id)).seq, 0);
  assert.deepEqual(await states(cluster.id), { srv_2: "ok", srv_3: "ok" });
  assert.equal(
    rosterCalls.length,
    0,
    "the leader was not told anything either",
  );
});

test("after the replay the leader is told the roster and its answer corrects what was missed", async () => {
  const cluster = await eu();
  await inCluster(cluster.id, "prj_web", "srv_2");
  await db.insert(workloadPlacements).values({
    kind: "app",
    workloadId: "prj_web",
    replica: 0,
    memberServerId: "srv_2",
    epoch: 1,
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  setSnapshot({
    head: 0,
    clusters: {
      [cluster.id]: {
        epoch: 3,
        superseded: false,
        members: [
          { id: "srv_2", state: "ok" },
          { id: "srv_3", state: "not_responding" },
        ],
      },
    },
  });
  assert.equal(await watchUntil(cluster.id, 0), "ended");
  assert.equal(rosterCalls.length, 1);
  const sent = rosterCalls[0] as {
    cluster: string;
    epoch: number;
    members: { id: string; fingerprint: string }[];
    placement: Record<string, unknown>[];
  };
  assert.equal(sent.cluster, cluster.id);
  assert.equal(sent.epoch, 1);
  assert.deepEqual(
    sent.members.map((m) => [m.id, m.fingerprint]),
    [
      ["srv_2", "2".repeat(64)],
      ["srv_3", "3".repeat(64)],
    ],
  );
  assert.deepEqual(sent.placement, [
    {
      kind: "app",
      id: "prj_web",
      replica: 0,
      member: "srv_2",
      slug: "prj_web",
      singleWriter: false,
      epoch: 1,
    },
  ]);
  assert.deepEqual(await states(cluster.id), {
    srv_2: "ok",
    srv_3: "not_responding",
  });
  assert.equal((await stored(cluster.id)).epoch, 3);
});

test("a roster push is not repeated until something in it changes", async () => {
  const cluster = await eu();
  const c = (await getClusterById(cluster.id))!;
  assert.equal(await pushLeaderRoster(c, { onlyIfChanged: true }), true);
  assert.equal(await pushLeaderRoster(c, { onlyIfChanged: true }), false);
  await inCluster(cluster.id, "prj_web", "srv_2");
  await db.insert(workloadPlacements).values({
    kind: "app",
    workloadId: "prj_web",
    replica: 0,
    memberServerId: "srv_3",
    epoch: 1,
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  assert.equal(await pushLeaderRoster(c, { onlyIfChanged: true }), true);
  assert.equal(rosterCalls.length, 2);
});

test("a leader on a newer epoch is adopted, not fought", async () => {
  const cluster = await eu();
  setRosterRefusal(
    "the leader refused leader.roster: the leader holds a newer epoch: 8",
  );
  setSnapshot({
    head: 0,
    clusters: { [cluster.id]: { epoch: 8, superseded: false, members: [] } },
  });
  const c = (await getClusterById(cluster.id))!;
  // The first push is refused; once the leader says 8, the retry is sent at 8.
  const refuseOnce = rosterRefusal;
  const method = leader.leader;
  let refused = false;
  leader.leader = (m, p) => {
    if (m === "leader.roster" && !refused) {
      refused = true;
      throw new Error(refuseOnce);
    }
    if (m === "leader.roster") {
      rosterCalls.push(JSON.parse(new TextDecoder().decode(p)));
      return enc({ ok: true });
    }
    return method(m, p);
  };
  setRosterRefusal("");
  await pushLeaderRoster(c);
  assert.equal((await stored(cluster.id)).epoch, 8);
  assert.equal((rosterCalls[0] as { epoch: number }).epoch, 8);
});

test("a database is single-writer, and so is an App with a volume; a plain App is not", async () => {
  const cluster = await eu();
  await inCluster(cluster.id, "prj_files", "srv_2");
  await inCluster(cluster.id, "prj_plain", "srv_2");
  await inCluster(cluster.id, "prj_config", "srv_2");
  await inCluster(cluster.id, "prj_sqlite", "srv_2");
  await pg.exec(`insert into app_volumes (app_id, position, volume_id, type, name, mount_path, read_only)
    values ('prj_files', 0, 'vol_1', 'named', 'data', '/data', false)`);
  // A File Deplo writes at every deploy travels with the stack; one only its server holds does not.
  await pg.exec(`insert into app_volumes (app_id, position, volume_id, type, name, project_path, mount_path, read_only)
    values ('prj_config', 0, 'vol_2', 'app', 'conf', 'conf/app.toml', '/app/conf/app.toml', true),
           ('prj_sqlite', 0, 'vol_3', 'app', 'db', 'data.sqlite', '/app/data.sqlite', false)`);
  await pg.exec(`insert into app_mounts (app_id, position, file_path, content)
    values ('prj_config', 0, 'conf/app.toml', 'a = 1')`);
  for (const id of ["prj_files", "prj_plain", "prj_config", "prj_sqlite"])
    await db.insert(workloadPlacements).values({
      kind: "app",
      workloadId: id,
      replica: 0,
      memberServerId: "srv_2",
      epoch: 1,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
  const entries = await placementEntries(cluster.id);
  assert.deepEqual(
    entries.map((e) => [e.id, e.singleWriter]),
    [
      ["prj_config", false],
      ["prj_files", true],
      ["prj_plain", false],
      ["prj_sqlite", true],
    ],
  );
});

test("a server agent without the leader capability is named, and so is a leader that is not running", async () => {
  const cluster = await eu();
  leader.capabilities = ["hostops"];
  await assert.rejects(
    () => watchClusterOnce(cluster.id),
    /cluster leader|update/i,
  );
  leader.capabilities = ["cluster.host", "cluster"];
  leader.status = { ...leader.status, running: false };
  await assert.rejects(() => watchClusterOnce(cluster.id), /not running/);
  assert.deepEqual(leader.watch.opens, [], "no watch was opened");
});

test("a leader below the pinned floor is refused for the watch as for a call", async () => {
  const cluster = await eu();
  __setClusterPinForTest({ version: "0.3.0", min: "0.3.0" });
  await assert.rejects(() => watchClusterOnce(cluster.id), /0\.2\.0|0\.3\.0/);
  assert.deepEqual(leader.watch.opens, []);
});

// eu, 23 Nov 2026: "eu-1 answers again" twice while eu-1 was off: a leader that just took over reports every server
// "ok" until it hears it. Then the same leader's "not responding" took a fenced server back a step.
