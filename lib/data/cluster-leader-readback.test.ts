import { test } from "node:test";
import assert from "node:assert/strict";

import { eq } from "drizzle-orm";

import { TEAM_B } from "./identity-test-helpers";
import { seedApp } from "./app-graph-test-helpers";
import { __settleAlertsForTest } from "../notify/dispatch";
import { captureFetch } from "../notify/fetch-capture-test-helpers";
import { apps as appsTable } from "../db/schema/control-plane/apps";
import { clusterImageCopies } from "../db/schema/control-plane/clusters";
import { domains as domainsTable } from "../db/schema/control-plane/domains";
import { getClusterById } from "./clusters/roster";
import { askLeaderToPlace, waitingForRoomNote } from "./clusters/placement";
import { pushLeaderRoster } from "./clusters/leader-sync";
import { reconcileCluster } from "./clusters/watch";
import { saveNotificationChannel } from "./notifications";
import { AT, failoverLab } from "./cluster-failover-test-helpers";

const lab = failoverLab();
const {
  asAdmin,
  eu,
  web,
  startedOn,
  autoDomain,
  placedOn,
  leaderMoved,
  watchUntil,
  event,
  apply,
  messages,
} = lab;

test("the leader is asked with real member facts: architecture, free memory, held images and workloads", async () => {
  const cluster = await eu();
  await web(cluster.id);
  await lab.db.insert(clusterImageCopies).values({
    appId: "prj_web",
    imageRef: "deplo/web:abc",
    serverId: "srv_3",
    state: "held",
    error: "",
    createdAt: AT,
    updatedAt: AT,
  });
  await lab.db
    .update(appsTable)
    .set({ resourceMemLimitMb: 512 })
    .where(eq(appsTable.id, "prj_web"));
  const c = (await getClusterById(cluster.id))!;
  const member = await askLeaderToPlace(c, {
    kind: "app",
    id: "prj_new",
    name: "new",
    environmentId: null,
    limitMb: 256,
    imageRef: "deplo/web:abc",
    archs: ["amd64"],
  });
  assert.equal(member, "srv_3");
  const ask = lab.calls.find((x) => x.method === "placement.place")!;
  const w = ask.body.workload as Record<string, unknown>;
  assert.equal(w.image, "deplo/web:abc");
  assert.deepEqual(w.archs, ["amd64"]);
  const facts = Object.fromEntries(
    (ask.body.members as { id: string }[]).map((m) => [
      m.id,
      m as Record<string, unknown>,
    ]),
  );
  assert.equal(
    facts.srv_2.freeMb,
    2048 - 512,
    "the App's limit is taken off the member it runs on",
  );
  assert.equal(facts.srv_2.workloads, 1);
  assert.equal(facts.srv_3.freeMb, 2048);
  assert.deepEqual(facts.srv_3.images, ["deplo/web:abc"]);
  assert.deepEqual(facts.srv_2.images, []);
  assert.equal(facts.srv_3.arch, "amd64");
});

test("the roster carries the same facts so the leader can place while Deplo is away", async () => {
  const cluster = await eu();
  await web(cluster.id);
  const c = (await getClusterById(cluster.id))!;
  await pushLeaderRoster(c);
  const roster = lab.calls.find((x) => x.method === "leader.roster")!;
  const m = (roster.body.members as Record<string, unknown>[]).find(
    (x) => x.id === "srv_3",
  )!;
  assert.equal(m.arch, "amd64");
  assert.equal(m.freeMb, 2048);
  assert.deepEqual(m.images, []);
  assert.equal(m.emptying, false);
});

test("a member whose agent cannot start a moved App is marked for the leader and named in Activity once", async () => {
  const cluster = await eu();
  await web(cluster.id);
  lab.members.srv_3.capabilities = ["cluster", "cluster.images"];
  const c = (await getClusterById(cluster.id))!;
  await pushLeaderRoster(c);
  await pushLeaderRoster(c);
  const roster = lab.calls.findLast((x) => x.method === "leader.roster")!;
  const by = Object.fromEntries(
    (roster.body.members as { id: string; noFailover?: boolean }[]).map((m) => [
      m.id,
      m.noFailover,
    ]),
  );
  assert.equal(by.srv_3, true, "the leader must never hand it a start");
  assert.equal(by.srv_2, undefined);
  assert.deepEqual(
    (await messages()).filter((m) => /too old/.test(m.message)),
    [
      {
        message:
          "The server agent on server-3 is too old to take over Apps when another server in cluster eu stops. Deplo updates it on its own.",
        actor: "Deplo",
      },
    ],
  );
});

test("a member that does not answer is not called too old", async () => {
  const cluster = await eu();
  lab.members.srv_3.unreachable = true;
  await pushLeaderRoster((await getClusterById(cluster.id))!);
  const roster = lab.calls.findLast((x) => x.method === "leader.roster")!;
  const m = (roster.body.members as Record<string, unknown>[]).find(
    (x) => x.id === "srv_3",
  )!;
  assert.equal(m.noFailover, undefined);
  assert.deepEqual(
    (await messages()).filter((x) => /too old/.test(x.message)),
    [],
  );
});

test("after a reconnect the leader's own moves are read back before the roster goes out, so a stale mirror never undoes them", async () => {
  const cluster = await eu();
  await web(cluster.id);
  startedOn("srv_3");
  leaderMoved(cluster.id, [{ id: "prj_web", member: "srv_3", seq: 4 }]);

  await reconcileCluster(cluster.id);

  assert.deepEqual(await placedOn(), ["srv_3"]);
  const [app] = await lab.db
    .select()
    .from(appsTable)
    .where(eq(appsTable.id, "prj_web"));
  assert.equal(app.serverId, "srv_3");
  const rosters = lab.calls.filter((c) => c.method === "leader.roster");
  assert.equal(rosters.length, 1);
  assert.deepEqual(
    (rosters[0].body.placement as { id: string; member: string }[]).map((e) => [
      e.id,
      e.member,
    ]),
    [["prj_web", "srv_3"]],
    "the roster repeats the leader's move instead of the old mirror",
  );
  assert.ok(
    lab.calls.findIndex((c) => c.method === "leader.snapshot") <
      lab.calls.findIndex((c) => c.method === "leader.roster"),
    "the snapshot is read first",
  );
});

test("a watch that lost events reads the missed failover from the snapshot: Activity, the address and one alert", async () => {
  const cluster = await eu();
  await web(cluster.id);
  await web(cluster.id, "prj_two");
  await autoDomain();
  startedOn("srv_3");
  await asAdmin(() =>
    saveNotificationChannel(null, {
      kind: "webhook",
      name: "",
      enabled: true,
      url: "https://ops/hook",
      target: "",
      emailFrom: "",
      emailProvider: "resend",
      smtpHost: "",
      smtpPort: 587,
      smtpUser: "",
      alerts: ["cluster_failover_waiting"],
    }),
  );
  lab.capture = captureFetch();
  // The buffer dropped everything up to 8; only the last event is still there.
  lab.leader.watch.gap = true;
  lab.leader.watch.log.push({
    seq: 9,
    at: AT,
    type: "member_state",
    cluster: cluster.id,
    data: { member: "srv_2", state: "fenced" },
  });
  leaderMoved(cluster.id, [
    { id: "prj_web", member: "srv_3", seq: 4 },
    { id: "prj_two", member: "", seq: 5 },
  ]);

  assert.equal(await watchUntil(cluster.id, 9), "ended");
  await __settleAlertsForTest();

  assert.deepEqual(await placedOn(), ["srv_3"]);
  assert.deepEqual(await placedOn("prj_two"), [null]);
  assert.deepEqual(
    (await messages()).filter((m) => /^Moved /.test(m.message)),
    [
      {
        message: "Moved web to server-3: server-2 stopped answering",
        actor: "Deplo",
      },
    ],
  );
  assert.equal(
    (await lab.db.select().from(domainsTable))[0].name,
    "web-word-0a000003.deplo.site",
  );
  assert.equal(
    await waitingForRoomNote("prj_two", "eu"),
    "Waiting for room in eu",
  );
  assert.equal(lab.capture.calls.length, 1);
  assert.match(
    String((lab.capture.calls[0].body as { title?: string }).title),
    // The leader's picture no longer says why it waits, so the alert does not claim it is room.
    /prj_two waiting to move in eu/,
  );
});

test("a watch that lost nothing writes the failover once: the snapshot adds no second entry", async () => {
  const cluster = await eu();
  await web(cluster.id);
  startedOn("srv_3");
  lab.leader.watch.push("placement", cluster.id, {
    kind: "app",
    workloadId: "prj_web",
    members: ["srv_3"],
    epoch: 1,
  });
  const told = lab.leader.watch.push("failed_over", cluster.id, {
    kind: "app",
    workloadId: "prj_web",
    from: "srv_2",
    to: "srv_3",
    reason: "stopped_answering",
  });
  leaderMoved(cluster.id, [{ id: "prj_web", member: "srv_3", seq: told.seq }]);

  assert.equal(await watchUntil(cluster.id, told.seq), "ended");
  assert.equal(
    (await messages()).filter((m) => /^Moved /.test(m.message)).length,
    1,
  );
});

test("an App waiting for room stays in the roster with no member, so the leader keeps trying it", async () => {
  const cluster = await eu();
  lab.seq = 0;
  await web(cluster.id);
  await apply(
    cluster.id,
    event(cluster.id, "placement", {
      kind: "app",
      workloadId: "prj_web",
      members: [""],
      epoch: 1,
    }),
  );
  await pushLeaderRoster((await getClusterById(cluster.id))!);
  const roster = lab.calls.findLast((x) => x.method === "leader.roster")!;
  assert.deepEqual(
    (roster.body.placement as { id: string; member: string }[]).map((e) => [
      e.id,
      e.member,
    ]),
    [["prj_web", ""]],
  );
});

test("a snapshot naming an App of another cluster or team moves and says nothing", async () => {
  const cluster = await eu();
  await seedApp(lab.db, {
    id: "prj_other",
    slug: "other",
    serverId: "srv_2",
    teamId: TEAM_B,
  });
  leaderMoved(cluster.id, [{ id: "prj_other", member: "srv_3", seq: 4 }]);
  await reconcileCluster(cluster.id, { after: 0, before: 9 });
  const [other] = await lab.db
    .select()
    .from(appsTable)
    .where(eq(appsTable.id, "prj_other"));
  assert.equal(other.serverId, "srv_2");
  assert.deepEqual(await placedOn("prj_other"), []);
  assert.deepEqual(
    (await messages()).filter((m) => /Moved|waiting/.test(m.message)),
    [],
  );
});
