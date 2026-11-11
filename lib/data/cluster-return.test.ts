import { test } from "node:test";
import assert from "node:assert/strict";

import { eq } from "drizzle-orm";

import { TEAM_A, TEAM_B } from "./identity-test-helpers";
import { seedApp } from "./app-graph-test-helpers";
import { seedDatabase } from "./backup-test-helpers";
import { __settleAlertsForTest } from "../notify/dispatch";
import { captureFetch } from "../notify/fetch-capture-test-helpers";
import { activities } from "../db/schema/control-plane/activity";
import { databases as databasesTable } from "../db/schema/control-plane/databases";
import { deploMoves } from "../db/schema/control-plane/deplo-move";
import { invalidateFrozen } from "./deplo-move/freeze";
import { runWithIdentity } from "../auth/request-context";
import { applyLeaderEvent } from "./clusters/watch";
import { saveNotificationChannel } from "./notifications";
import { AT, failoverLab } from "./cluster-failover-test-helpers";
import { USER_1 } from "./identity-test-helpers";

const lab = failoverLab();
const { asAdmin, eu, web, watchUntil, event } = lab;

const hook = (url: string) => ({
  kind: "webhook" as const,
  name: "",
  enabled: true,
  url,
  target: "",
  emailFrom: "",
  emailProvider: "resend" as const,
  smtpHost: "",
  smtpPort: 587,
  smtpUser: "",
  alerts: ["cluster_member_returned" as const],
});

const entries = async (teamId: string) =>
  (await lab.db.select().from(activities))
    .filter(
      (a) => a.teamId === teamId && / is back in cluster /.test(a.message),
    )
    .map((a) => ({ message: a.message, actor: a.actor, appId: a.appId }));

const alerts = () =>
  lab.capture!.calls.map((c) => {
    const b = c.body as { title?: string; body?: string };
    return { url: c.url, title: b.title, body: b.body };
  });

test("a return through the watch writes one Activity entry by Deplo and sends one alert, naming what was stopped", async () => {
  const cluster = await eu();
  await web(cluster.id);
  await web(cluster.id, "prj_api");
  await asAdmin(() => saveNotificationChannel(null, hook("https://ops/hook")));
  lab.capture = captureFetch();

  const told = lab.leader.watch.push("member_returned", cluster.id, {
    member: "srv_2",
    stopped: [
      { kind: "app", workloadId: "prj_web" },
      { kind: "app", workloadId: "prj_api" },
    ],
  });
  assert.equal(await watchUntil(cluster.id, told.seq), "ended");
  await __settleAlertsForTest();

  assert.deepEqual(await entries(TEAM_A), [
    {
      message:
        "server-2 is back in cluster eu. Its copies of prj_api and web were stopped: they run on other servers now.",
      actor: "Deplo",
      appId: null,
    },
  ]);
  assert.deepEqual(alerts(), [
    {
      url: "https://ops/hook",
      title: "server-2 is back in cluster eu",
      body: "Its copies of prj_api and web were stopped: they run on other servers now.",
    },
  ]);

  // The same event replayed after a reconnect says nothing twice.
  assert.equal(
    await applyLeaderEvent(cluster.id, {
      seq: told.seq,
      type: "member_returned",
      cluster: cluster.id,
      data: {
        member: "srv_2",
        stopped: [{ kind: "app", workloadId: "prj_web" }],
      },
    }),
    "skipped",
  );
  await __settleAlertsForTest();
  assert.equal((await entries(TEAM_A)).length, 1);
  assert.equal(lab.capture.calls.length, 1);
});

test("one App or one database reads in the singular, and the entry belongs to that App", async () => {
  const cluster = await eu();
  await web(cluster.id);
  await seedDatabase(lab.db, {
    id: "db_shop",
    name: "shop",
    serverId: "srv_3",
  });
  await lab.db
    .update(databasesTable)
    .set({ clusterId: cluster.id })
    .where(eq(databasesTable.id, "db_shop"));
  lab.seq = 0;
  await applyLeaderEvent(
    cluster.id,
    event(cluster.id, "member_returned", {
      member: "srv_2",
      stopped: [{ kind: "app", workloadId: "prj_web" }],
    }),
  );
  await applyLeaderEvent(
    cluster.id,
    event(cluster.id, "member_returned", {
      member: "srv_3",
      stopped: [{ kind: "database", workloadId: "db_shop" }],
    }),
  );
  assert.deepEqual(await entries(TEAM_A), [
    {
      message:
        "server-2 is back in cluster eu. Its copy of web was stopped: web runs on another server now.",
      actor: "Deplo",
      appId: "prj_web",
    },
    {
      message:
        "server-3 is back in cluster eu. Its copy of shop was stopped: shop runs on another server now.",
      actor: "Deplo",
      appId: null,
    },
  ]);
});

test("a cluster shared by two teams tells each one about its own Apps only", async () => {
  const cluster = await eu();
  await web(cluster.id);
  await web(cluster.id, "prj_theirs", TEAM_B);
  await asAdmin(() => saveNotificationChannel(null, hook("https://ops/a")));
  await runWithIdentity({ userId: "user_b", teamId: TEAM_B }, () =>
    saveNotificationChannel(null, hook("https://ops/b")),
  );
  lab.capture = captureFetch();
  lab.seq = 0;
  await applyLeaderEvent(
    cluster.id,
    event(cluster.id, "member_returned", {
      member: "srv_2",
      stopped: [
        { kind: "app", workloadId: "prj_web" },
        { kind: "app", workloadId: "prj_theirs" },
      ],
    }),
  );
  await __settleAlertsForTest();

  const [a] = await entries(TEAM_A);
  const [b] = await entries(TEAM_B);
  assert.equal(
    a.message,
    "server-2 is back in cluster eu. Its copy of web was stopped: web runs on another server now.",
  );
  assert.equal(
    b.message,
    "server-2 is back in cluster eu. Its copy of prj_theirs was stopped: prj_theirs runs on another server now.",
  );
  assert.equal((await entries(TEAM_A)).length, 1);
  assert.equal((await entries(TEAM_B)).length, 1);
  const sent = alerts().sort((x, y) => x.url.localeCompare(y.url));
  assert.equal(sent.length, 2, "one alert per team that had something stopped");
  assert.doesNotMatch(sent[0].body!, /prj_theirs/);
  assert.doesNotMatch(sent[1].body!, /web/);
});

test("a return that names an App of another cluster, or nothing at all, says nothing", async () => {
  const cluster = await eu();
  await seedApp(lab.db, { id: "prj_other", slug: "other", serverId: "srv_2" });
  lab.seq = 0;
  for (const stopped of [[{ kind: "app", workloadId: "prj_other" }], []])
    assert.equal(
      await applyLeaderEvent(
        cluster.id,
        event(cluster.id, "member_returned", { member: "srv_2", stopped }),
      ),
      "applied",
    );
  assert.deepEqual(await entries(TEAM_A), []);
});

test("a Deplo move in progress applies no return", async () => {
  const cluster = await eu();
  await web(cluster.id);
  await lab.db.insert(deploMoves).values({
    id: "dmv_1",
    side: "target",
    state: "copying",
    peerUrl: "https://new.example.com",
    startedBy: USER_1,
    createdAt: AT,
    updatedAt: AT,
  });
  invalidateFrozen();
  lab.seq = 0;
  const r = await applyLeaderEvent(
    cluster.id,
    event(cluster.id, "member_returned", {
      member: "srv_2",
      stopped: [{ kind: "app", workloadId: "prj_web" }],
    }),
  );
  assert.equal(r, "frozen");
  assert.deepEqual(await entries(TEAM_A), []);
});
