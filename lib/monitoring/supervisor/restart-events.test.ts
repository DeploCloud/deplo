import { test, afterEach } from "node:test";
import assert from "node:assert/strict";

import { eq } from "drizzle-orm";

import { apps as appsTable } from "../../db/schema/control-plane/apps";
import { activities } from "../../db/schema/control-plane/activity";
import { runWithIdentity } from "../../auth/request-context";
import {
  seedApp,
  seedDeployment,
  seedPreview,
} from "../../data/app-graph-test-helpers";
import {
  clusters,
  workloadPlacements,
} from "../../db/schema/control-plane/clusters";
import { setAppRestartWhenUnresponsive } from "../../data/apps/settings";
import { saveNotificationChannel } from "../../data/notifications";
import { TEAM_A, USER_1 } from "../../data/identity-test-helpers";
import { commitOutcome } from "../../deploy/build/deployment-state";
import { __resetCooldowns } from "../../notify/cooldown";
import { __settleAlertsForTest } from "../../notify/dispatch";
import {
  captureFetch,
  type FetchCapture,
} from "../../notify/fetch-capture-test-helpers";
import { RestartEvent_Kind, type RestartEvent } from "../../agent/gen/agent";
import {
  SRV_A,
  SRV_B,
  frame,
  seedEnrolledServer,
  setupSupervisor,
  streamingServer,
  waitFor,
} from "./supervisor-test-helpers";

const h = setupSupervisor();
let capture: FetchCapture | null = null;

afterEach(() => {
  capture?.restore();
  capture = null;
});

const ev = (
  kind: RestartEvent_Kind,
  over: Partial<RestartEvent> = {},
): RestartEvent => ({
  kind,
  slug: "web",
  container: "web-1",
  unansweredS: 0,
  restarts: 0,
  reason: "",
  atUnixMs: 0,
  ...over,
});

async function setup() {
  const feed = await streamingServer(h.db);
  await seedApp(h.db, { id: "prj_web", slug: "web", serverId: SRV_A });
  await h.db
    .update(appsTable)
    .set({ name: "web" })
    .where(eq(appsTable.id, "prj_web"));
  __resetCooldowns();
  await runWithIdentity({ userId: USER_1, teamId: TEAM_A }, () =>
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
      alerts: ["app_unresponsive", "app_restarts_paused"],
    }),
  );
  capture = captureFetch();
  return feed;
}

async function send(
  feed: Awaited<ReturnType<typeof setup>>,
  ...e: RestartEvent[]
) {
  await feed.send({ ...frame(), restartEvents: e });
  await __settleAlertsForTest();
}

const messages = async () =>
  (await h.db.select().from(activities)).map((a) => a.message);
const paused = async () =>
  (
    await h.db
      .select({ at: appsTable.restartsPausedAt })
      .from(appsTable)
      .where(eq(appsTable.id, "prj_web"))
  )[0].at;
const titles = () =>
  capture!.calls.map((c) => String((c.body as { title?: string }).title ?? ""));

test("a restart is an Activity entry by Deplo and the first one alerts", async () => {
  const feed = await setup();
  await send(
    feed,
    ev(RestartEvent_Kind.KIND_RESTARTED, { unansweredS: 90, restarts: 1 }),
  );
  await waitFor(async () => (await messages()).length === 1, "activity");
  const [row] = await h.db.select().from(activities);
  assert.equal(row.message, "Restarted web: it stopped answering for 90 s");
  assert.equal(row.actor, "Deplo");
  assert.equal(capture!.calls.length, 1);
  assert.match(titles()[0], /web stopped answering/);
});

test("with several replicas the entry names the one that was restarted", async () => {
  const feed = await setup();
  await h.db
    .update(appsTable)
    .set({ replicas: 3 })
    .where(eq(appsTable.id, "prj_web"));
  await send(
    feed,
    ev(RestartEvent_Kind.KIND_RESTARTED, {
      container: "deplo-web-deplo-web-2",
      unansweredS: 90,
    }),
  );
  await waitFor(async () => (await messages()).length === 1, "activity");
  assert.deepEqual(await messages(), [
    "Restarted web replica web-2: it stopped answering for 90 s",
  ]);
});

test("a spread App's restart on another server of its cluster reaches Activity, with the server", async () => {
  const feed = await setup();
  const at = "2026-01-01T00:00:00.000Z";
  await seedEnrolledServer(h.db, SRV_B, at);
  await h.db
    .insert(clusters)
    .values({ id: "clu_eu", name: "eu", createdAt: at });
  // It "runs on" srv_b; the server reporting here holds its second replica.
  await h.db
    .update(appsTable)
    .set({ clusterId: "clu_eu", serverId: SRV_B, replicas: 2 })
    .where(eq(appsTable.id, "prj_web"));
  await h.db.insert(workloadPlacements).values(
    [SRV_B, SRV_A].map((memberServerId, replica) => ({
      kind: "app",
      workloadId: "prj_web",
      replica,
      memberServerId,
      updatedAt: at,
    })),
  );
  await send(
    feed,
    ev(RestartEvent_Kind.KIND_RESTARTED, {
      container: "deplo-web-deplo-web-1",
      unansweredS: 90,
    }),
  );
  await waitFor(async () => (await messages()).length === 1, "activity");
  assert.deepEqual(await messages(), [
    `Restarted web replica web-1 on ${SRV_A}: it stopped answering for 90 s`,
  ]);
  assert.deepEqual(titles(), ["web stopped answering"]);
});

test("a preview's restart is an Activity entry and never the App's own state", async () => {
  const feed = await setup();
  await seedPreview(h.db, { id: "prv_7", appId: "prj_web", prNumber: 7 });
  await send(
    feed,
    ev(RestartEvent_Kind.KIND_RESTARTED, {
      slug: "web__pr-7",
      unansweredS: 90,
    }),
    ev(RestartEvent_Kind.KIND_PAUSED, { slug: "web__pr-7", restarts: 5 }),
  );
  await waitFor(async () => (await messages()).length === 2, "activity");
  assert.deepEqual((await messages()).sort(), [
    "Paused restarts for the preview for pull request #7 of web: it restarted 5 times in 30 minutes and still does not answer",
    "Restarted the preview for pull request #7 of web: it stopped answering for 90 s",
  ]);
  assert.equal(await paused(), null);
  assert.deepEqual(titles(), []);
});

test("an App on another server is never read from this one's events", async () => {
  const feed = await setup();
  await seedEnrolledServer(h.db, SRV_B, "2026-01-01T00:00:00.000Z");
  await h.db
    .update(appsTable)
    .set({ serverId: SRV_B })
    .where(eq(appsTable.id, "prj_web"));
  await send(feed, ev(RestartEvent_Kind.KIND_PAUSED, { restarts: 5 }));
  await send(feed, ev(RestartEvent_Kind.KIND_RESTARTED, { unansweredS: 90 }));
  assert.deepEqual(await messages(), []);
  assert.equal(await paused(), null);
});

test("more restarts inside the 30-minute cooldown are Activity only", async () => {
  const feed = await setup();
  for (const n of [1, 2, 3])
    await send(
      feed,
      ev(RestartEvent_Kind.KIND_RESTARTED, { unansweredS: 90, restarts: n }),
    );
  await waitFor(async () => (await messages()).length === 3, "activity");
  assert.equal(capture!.calls.length, 1);
});

test("a pause sets the App's state and alerts once", async () => {
  const feed = await setup();
  await send(feed, ev(RestartEvent_Kind.KIND_PAUSED, { restarts: 5 }));
  await send(feed, ev(RestartEvent_Kind.KIND_PAUSED, { restarts: 5 }));
  await waitFor(async () => (await paused()) !== null, "paused state");
  assert.match(titles()[0], /web is still not answering/);
  assert.equal(capture!.calls.length, 1);
  assert.ok((await messages()).some((m) => /Paused restarts for web/.test(m)));
});

test("the agent's resume clears the pause", async () => {
  const feed = await setup();
  await send(feed, ev(RestartEvent_Kind.KIND_PAUSED, { restarts: 5 }));
  await waitFor(async () => (await paused()) !== null, "paused state");
  await send(feed, ev(RestartEvent_Kind.KIND_RESUMED, { reason: "quiet" }));
  await waitFor(async () => (await paused()) === null, "pause cleared");
  assert.ok(
    (await messages()).includes(
      "Resumed restarts for web after 30 quiet minutes",
    ),
  );
});

test("a server agent that started again resumes a paused App, and says nothing about one that was not", async () => {
  const feed = await setup();
  // Every App with a rule gets this event when its server agent starts: only a paused one is news.
  await send(feed, ev(RestartEvent_Kind.KIND_RESUMED, { reason: "agent" }));
  await send(feed, ev(RestartEvent_Kind.KIND_PAUSED, { restarts: 5 }));
  await waitFor(async () => (await paused()) !== null, "paused state");
  await send(feed, ev(RestartEvent_Kind.KIND_RESUMED, { reason: "agent" }));
  await waitFor(async () => (await paused()) === null, "pause cleared");
  assert.deepEqual(
    (await messages()).filter((m) => /Resumed restarts/.test(m)),
    ["Resumed restarts for web after its server agent restarted"],
  );
});

test("a recovery after a restart alert says it answers again, once", async () => {
  const feed = await setup();
  await send(feed, ev(RestartEvent_Kind.KIND_RESTARTED, { unansweredS: 90 }));
  await send(feed, ev(RestartEvent_Kind.KIND_RECOVERED));
  await send(feed, ev(RestartEvent_Kind.KIND_RECOVERED));
  assert.equal(capture!.calls.length, 2);
  assert.match(titles()[1], /web is running again/);
});

test("a recovery nobody was told about stays quiet", async () => {
  const feed = await setup();
  await send(feed, ev(RestartEvent_Kind.KIND_RECOVERED));
  assert.equal(capture!.calls.length, 0);
});

// What an earlier Deplo process left in the database, with nothing in memory.
async function told(minutesAgo: number, recoveryOwed: boolean) {
  __resetCooldowns();
  await h.db
    .update(appsTable)
    .set({
      unresponsiveAlertedAt: new Date(
        Date.now() - minutesAgo * 60_000,
      ).toISOString(),
      recoveryAlertOwed: recoveryOwed,
    })
    .where(eq(appsTable.id, "prj_web"));
}

test("Deplo restarted between the restart and the recovery: it still says so", async () => {
  const feed = await setup();
  await told(5, true);
  await send(feed, ev(RestartEvent_Kind.KIND_RECOVERED));
  await send(feed, ev(RestartEvent_Kind.KIND_RECOVERED));
  assert.deepEqual(titles(), ["web is running again"]);
});

test("a restart inside the window stays quiet after Deplo restarted", async () => {
  const feed = await setup();
  await told(10, true);
  await send(feed, ev(RestartEvent_Kind.KIND_RESTARTED, { unansweredS: 90 }));
  await waitFor(async () => (await messages()).length === 1, "activity");
  assert.deepEqual(titles(), []);
});

test("a restart after the 30-minute window alerts again", async () => {
  const feed = await setup();
  await told(31, false);
  await send(feed, ev(RestartEvent_Kind.KIND_RESTARTED, { unansweredS: 90 }));
  assert.deepEqual(titles(), ["web stopped answering"]);
});

test("a restart and its recovery inside the window, after a recovery, stay quiet", async () => {
  const feed = await setup();
  await send(feed, ev(RestartEvent_Kind.KIND_RESTARTED, { unansweredS: 90 }));
  await send(feed, ev(RestartEvent_Kind.KIND_RECOVERED));
  await send(feed, ev(RestartEvent_Kind.KIND_RESTARTED, { unansweredS: 90 }));
  await send(feed, ev(RestartEvent_Kind.KIND_RECOVERED));
  await waitFor(async () => (await messages()).length === 2, "activity");
  assert.deepEqual(titles(), ["web stopped answering", "web is running again"]);
});

test("a new pause after restarting resumed alerts again", async () => {
  const feed = await setup();
  await send(feed, ev(RestartEvent_Kind.KIND_PAUSED, { restarts: 5 }));
  await send(feed, ev(RestartEvent_Kind.KIND_RESUMED, { reason: "restart" }));
  await send(feed, ev(RestartEvent_Kind.KIND_PAUSED, { restarts: 5 }));
  assert.deepEqual(titles(), [
    "web is still not answering",
    "web is still not answering",
  ]);
});

test("a recovery after a pause alert says it answers again", async () => {
  const feed = await setup();
  await told(10, false);
  await send(feed, ev(RestartEvent_Kind.KIND_PAUSED, { restarts: 5 }));
  await send(feed, ev(RestartEvent_Kind.KIND_RECOVERED));
  assert.deepEqual(titles(), [
    "web is still not answering",
    "web is running again",
  ]);
});

test("an event for an App on another server is ignored", async () => {
  const feed = await setup();
  await send(feed, ev(RestartEvent_Kind.KIND_PAUSED, { slug: "nobody" }));
  assert.equal(await paused(), null);
  assert.equal(capture!.calls.length, 0);
});

test("a successful deploy clears the pause", async () => {
  await seedEnrolledServer(h.db, SRV_A, "2026-01-01T00:00:00.000Z");
  await seedApp(h.db, { id: "prj_web", slug: "web", serverId: SRV_A });
  await seedDeployment(h.db, {
    id: "dpl_1",
    appId: "prj_web",
    status: "building",
  });
  await h.db
    .update(appsTable)
    .set({ restartsPausedAt: "2026-11-10T03:00:00.000Z" })
    .where(eq(appsTable.id, "prj_web"));
  await commitOutcome(
    "dpl_1",
    { kind: "app", appId: "prj_web", teamId: TEAM_A, name: "web", slug: "web" },
    { status: "ready" },
    {},
  );
  assert.equal(await paused(), null);
});

test("a deploy or a manual start settles what was owed: a later recovery announces nothing", async () => {
  const feed = await setup();
  await send(feed, ev(RestartEvent_Kind.KIND_RESTARTED, { unansweredS: 90 }));
  await waitFor(async () => capture!.calls.length === 1, "the first alert");
  await seedDeployment(h.db, {
    id: "dpl_1",
    appId: "prj_web",
    status: "building",
  });
  await commitOutcome(
    "dpl_1",
    { kind: "app", appId: "prj_web", teamId: TEAM_A, name: "web", slug: "web" },
    { status: "ready" },
    {},
  );
  await __settleAlertsForTest();
  const before = capture!.calls.length;
  await send(feed, ev(RestartEvent_Kind.KIND_RECOVERED));
  assert.ok(
    !titles()
      .slice(before)
      .some((t) => /running again/.test(t)),
    titles().join(" | "),
  );
});

test("flipping the restart switch does not clear a pause the server agent still holds", async () => {
  const feed = await setup();
  await send(feed, ev(RestartEvent_Kind.KIND_PAUSED, { restarts: 5 }));
  await waitFor(async () => (await paused()) !== null, "paused state");
  await runWithIdentity({ userId: USER_1, teamId: TEAM_A }, () =>
    setAppRestartWhenUnresponsive("prj_web", false),
  );
  assert.notEqual(await paused(), null);
});
