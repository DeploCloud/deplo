import { test } from "node:test";
import assert from "node:assert/strict";

import { eq } from "drizzle-orm";

import { TEAM_B, USER_1 } from "./identity-test-helpers";
import { seedApp } from "./app-graph-test-helpers";
import { __settleAlertsForTest } from "../notify/dispatch";
import { captureFetch } from "../notify/fetch-capture-test-helpers";
import { activities as activitiesTable } from "../db/schema/control-plane/activity";
import { apps as appsTable } from "../db/schema/control-plane/apps";
import { deploMoves } from "../db/schema/control-plane/deplo-move";
import { deployments as deploymentsTable } from "../db/schema/control-plane/deployments";
import { domains as domainsTable } from "../db/schema/control-plane/domains";
import { invalidateFrozen } from "./deplo-move/freeze";
import {
  appWaitingNote,
  listClusterWaiting,
  waitingForRoomNote,
} from "./clusters/placement";
import { applyLeaderEvent } from "./clusters/watch";
import { rehostClusterAddresses } from "./clusters/failover-address";
import { runWithIdentity } from "../auth/request-context";
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
  event,
  apply,
  messages,
} = lab;

test("a failover moves the placement and server_id, writes one Activity entry by Deplo and re-hosts a generated address", async () => {
  const cluster = await eu();
  lab.seq = 0;
  await web(cluster.id);
  await autoDomain();
  startedOn("srv_3");

  await apply(
    cluster.id,
    event(cluster.id, "placement", {
      kind: "app",
      workloadId: "prj_web",
      members: ["srv_3"],
      epoch: 1,
    }),
    event(cluster.id, "failed_over", {
      kind: "app",
      workloadId: "prj_web",
      from: "srv_2",
      to: "srv_3",
      reason: "stopped_answering",
    }),
  );

  assert.deepEqual(await placedOn(), ["srv_3"]);
  const [app] = await lab.db
    .select()
    .from(appsTable)
    .where(eq(appsTable.id, "prj_web"));
  assert.equal(app.serverId, "srv_3");
  assert.equal(app.productionUrl, "https://web-word-0a000003.deplo.site");
  const moved = (await messages()).filter((m) => /^Moved /.test(m.message));
  assert.deepEqual(moved, [
    {
      message: "Moved web to server-3: server-2 stopped answering",
      actor: "Deplo",
    },
  ]);
  const [dom] = await lab.db.select().from(domainsTable);
  assert.equal(dom.name, "web-word-0a000003.deplo.site");
  // The running stack is re-routed where it is: nothing is rebuilt, and the server that died is not asked.
  const sent = lab.members.srv_3.reroutes;
  assert.equal(sent.length, 1);
  assert.match(sent[0].composeYaml, /web-word-0a000003\.deplo\.site/);
  assert.doesNotMatch(sent[0].composeYaml, /0a000002/);
  assert.equal(lab.members.srv_2.reroutes.length, 0);
  assert.equal((await lab.db.select().from(deploymentsTable)).length, 0);
  assert.deepEqual(
    (await messages()).filter((m) => /generated address/.test(m.message)),
    [
      {
        message:
          "web moved to another server of its cluster, so its generated address is now web-word-0a000003.deplo.site",
        actor: "Deplo",
      },
    ],
  );
});

test("the generated address waits until the App's stack is on the new member, and the sweep catches it up", async () => {
  const cluster = await eu();
  lab.seq = 0;
  await web(cluster.id);
  await autoDomain();
  await apply(
    cluster.id,
    event(cluster.id, "placement", {
      kind: "app",
      workloadId: "prj_web",
      members: ["srv_3"],
      epoch: 1,
    }),
    event(cluster.id, "failed_over", {
      kind: "app",
      workloadId: "prj_web",
      from: "srv_2",
      to: "srv_3",
      reason: "stopped_answering",
    }),
  );
  assert.equal(
    (await lab.db.select().from(domainsTable))[0].name,
    "web-word-0a000002.deplo.site",
    "a name is not moved to a server that does not run the App yet",
  );

  startedOn("srv_3");
  await rehostClusterAddresses();
  assert.equal(
    (await lab.db.select().from(domainsTable))[0].name,
    "web-word-0a000003.deplo.site",
  );
  assert.equal(lab.members.srv_3.reroutes.length, 1);
  // Nothing left to do: a second sweep changes and sends nothing.
  await rehostClusterAddresses();
  assert.equal(lab.members.srv_3.reroutes.length, 1);
});

test("a generated address another team already routes is left alone, and Activity says so once", async () => {
  const cluster = await eu();
  lab.seq = 0;
  await web(cluster.id);
  await autoDomain();
  await seedApp(lab.db, { id: "prj_b", serverId: "srv_3", teamId: TEAM_B });
  await lab.db.insert(domainsTable).values({
    id: "dom_b",
    appId: "prj_b",
    name: "web-word-0a000003.deplo.site",
    pathPrefix: "/api",
    status: "valid",
    isPrimary: true,
    ssl: false,
    source: "custom",
    createdAt: AT,
  });
  startedOn("srv_3");
  await lab.db
    .update(appsTable)
    .set({ serverId: "srv_3" })
    .where(eq(appsTable.id, "prj_web"));

  await rehostClusterAddresses();
  await rehostClusterAddresses();
  const [mine] = await lab.db
    .select()
    .from(domainsTable)
    .where(eq(domainsTable.id, "dom_prj_web"));
  assert.equal(mine.name, "web-word-0a000002.deplo.site");
  assert.equal(lab.members.srv_3.reroutes.length, 0);
  assert.deepEqual(
    (await messages()).filter((m) => /generated address/.test(m.message)),
    [
      {
        message:
          "web moved to another server of its cluster, but its generated address stays web-word-0a000002.deplo.site: web-word-0a000003.deplo.site is already routed by another team on this Deplo. A hostname belongs to one team.",
        actor: "Deplo",
      },
    ],
  );
});

test("what Deplo says about a cluster goes to the teams with work on it, never to the oldest team", async () => {
  const cluster = await eu();
  lab.seq = 0;
  await web(cluster.id, "prj_b", TEAM_B);
  const told = async () =>
    (await lab.db.select().from(activitiesTable))
      .filter((a) => a.actor === "Deplo" && a.type === "server")
      .map((a) => [a.teamId, a.message]);

  await apply(
    cluster.id,
    event(cluster.id, "member_state", { member: "srv_2", state: "fenced" }),
    event(cluster.id, "superseded", {}),
  );
  assert.deepEqual(await told(), [
    [
      TEAM_B,
      "server-2 has not responded for a minute in cluster eu, so it stopped the databases and Apps with files that must never run twice.",
    ],
    [
      TEAM_B,
      "Cluster eu's leader stepped down: a server in it follows a newer one.",
    ],
  ]);

  // Two teams with work on it each read it once.
  await web(cluster.id, "prj_a");
  await apply(
    cluster.id,
    event(cluster.id, "member_state", { member: "srv_2", state: "ok" }),
  );
  assert.deepEqual(
    (await told())
      .filter(([, m]) => /answers again/.test(m))
      .map(([t]) => t)
      .sort(),
    ["team_a", TEAM_B].sort(),
  );
});

test("a member that refuses the new routes leaves the old address in place and says so", async () => {
  const cluster = await eu();
  lab.seq = 0;
  await web(cluster.id);
  await autoDomain();
  startedOn("srv_3");
  lab.members.srv_3.rerouteError = "compose up failed";
  await apply(
    cluster.id,
    event(cluster.id, "placement", {
      kind: "app",
      workloadId: "prj_web",
      members: ["srv_3"],
      epoch: 1,
    }),
    event(cluster.id, "failed_over", {
      kind: "app",
      workloadId: "prj_web",
      from: "srv_2",
      to: "srv_3",
      reason: "stopped_answering",
    }),
  );
  assert.equal(
    (await lab.db.select().from(domainsTable))[0].name,
    "web-word-0a000002.deplo.site",
  );
  assert.equal(
    (await messages()).filter((m) =>
      /^web runs on server-3, but its generated address could not be updated yet: /.test(
        m.message,
      ),
    ).length,
    1,
  );
});

test("a failover of an App on its own domain writes the Activity entry and redeploys nothing", async () => {
  const cluster = await eu();
  lab.seq = 0;
  await web(cluster.id);
  await lab.db.insert(domainsTable).values({
    id: "dom_1",
    appId: "prj_web",
    name: "app.example.com",
    status: "valid",
    isPrimary: true,
    ssl: true,
    source: "custom",
    createdAt: AT,
  });
  await apply(
    cluster.id,
    event(cluster.id, "failed_over", {
      kind: "app",
      workloadId: "prj_web",
      from: "srv_2",
      to: "srv_3",
      reason: "stopped_answering",
    }),
  );
  assert.equal(
    (await lab.db.select().from(domainsTable))[0].name,
    "app.example.com",
  );
  assert.equal((await lab.db.select().from(deploymentsTable)).length, 0);
  assert.equal(
    (await messages()).filter((m) => /^Moved /.test(m.message)).length,
    1,
  );
});

test("an event naming an App of another cluster or team changes and says nothing", async () => {
  const cluster = await eu();
  lab.seq = 0;
  await seedApp(lab.db, { id: "prj_other", slug: "other", serverId: "srv_2" });
  await apply(
    cluster.id,
    event(cluster.id, "failed_over", {
      kind: "app",
      workloadId: "prj_other",
      from: "srv_2",
      to: "srv_3",
      reason: "stopped_answering",
    }),
  );
  assert.deepEqual(await messages(), []);
});

test("waiting Apps show the room note, and one alert goes out per failover that left something waiting", async () => {
  const cluster = await eu();
  lab.seq = 0;
  await web(cluster.id);
  await web(cluster.id, "prj_two");
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
  const waiting = [
    { kind: "app", workloadId: "prj_web", reason: "no_room", neededMb: 512 },
    { kind: "app", workloadId: "prj_two", reason: "no_room", neededMb: 512 },
  ];
  await apply(
    cluster.id,
    event(cluster.id, "placement", {
      kind: "app",
      workloadId: "prj_web",
      members: [""],
      epoch: 1,
    }),
    event(cluster.id, "placement", {
      kind: "app",
      workloadId: "prj_two",
      members: [""],
      epoch: 1,
    }),
    event(cluster.id, "failover", {
      member: "srv_2",
      reason: "stopped_answering",
      moved: [],
      waiting,
    }),
  );
  await __settleAlertsForTest();
  assert.equal(
    await waitingForRoomNote("prj_web", "eu"),
    "Waiting for room in eu",
  );
  assert.equal(
    lab.capture.calls.length,
    1,
    "one alert for the failover, not one per App",
  );
  assert.match(
    String((lab.capture.calls[0].body as { title?: string }).title),
    /2 Apps waiting for room in eu/,
  );
  const waits = (await messages()).filter((m) =>
    /waiting for room in eu/.test(m.message),
  );
  assert.equal(waits.length, 2);

  // A failover that left nothing waiting sends nothing.
  await apply(
    cluster.id,
    event(cluster.id, "failover", {
      member: "srv_2",
      reason: "stopped_answering",
      moved: ["prj_web"],
      waiting: [],
    }),
  );
  await __settleAlertsForTest();
  assert.equal(lab.capture.calls.length, 1);

  // Once it runs again the note clears.
  await apply(
    cluster.id,
    event(cluster.id, "placement", {
      kind: "app",
      workloadId: "prj_web",
      members: ["srv_3"],
      epoch: 1,
    }),
  );
  assert.equal(await waitingForRoomNote("prj_web", "eu"), null);
});

test("a wait says what stopped the move: a failed start, a missing image or no server online never read as no room", async () => {
  const cluster = await eu();
  lab.seq = 0;
  const ids = ["prj_web", "prj_two", "prj_three", "prj_four"];
  await web(cluster.id);
  for (const id of ids.slice(1)) await web(cluster.id, id);
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
  const why = ["start_failed", "no_image", "no_member_online", "no_room"];
  await apply(
    cluster.id,
    ...ids.map((workloadId) =>
      event(cluster.id, "placement", {
        kind: "app",
        workloadId,
        members: [""],
        epoch: 1,
      }),
    ),
    event(cluster.id, "failover", {
      member: "srv_2",
      reason: "stopped_answering",
      moved: [],
      waiting: ids.map((workloadId, i) => ({
        kind: "app",
        workloadId,
        reason: why[i],
        neededMb: 512,
      })),
    }),
  );
  await __settleAlertsForTest();
  const said = (await messages())
    .map((m) => m.message)
    .filter((m) => /is waiting/.test(m))
    .map((m) => m.replace(/^\S+ /, ""))
    .sort();
  assert.deepEqual(said, [
    "is waiting for room in eu: server-2 stopped answering and no other server has room yet",
    "is waiting in eu: server-2 stopped answering and it did not start on another server",
    "is waiting in eu: server-2 stopped answering and no other server has its image yet",
    "is waiting in eu: server-2 stopped answering and no other server is online and ready",
  ]);
  const alert = lab.capture.calls[0].body as { title?: string; body?: string };
  assert.equal(alert.title, "4 Apps waiting to move in eu");
  assert.match(String(alert.body), /did not start on another server\./);
  assert.match(String(alert.body), /No other server has the image of /);
  assert.match(String(alert.body), /No other server is online and ready for /);
  assert.match(String(alert.body), /No other server has room for /);
});

test("each team with something left waiting gets its own alert for one failover", async () => {
  const cluster = await eu();
  lab.seq = 0;
  await web(cluster.id);
  await web(cluster.id, "prj_theirs", TEAM_B);
  const channel = (url: string) => ({
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
    alerts: ["cluster_failover_waiting" as const],
  });
  await asAdmin(() => saveNotificationChannel(null, channel("https://a/hook")));
  await runWithIdentity({ userId: "user_b", teamId: TEAM_B }, () =>
    saveNotificationChannel(null, channel("https://b/hook")),
  );
  lab.capture = captureFetch();
  await apply(
    cluster.id,
    event(cluster.id, "failover", {
      member: "srv_2",
      reason: "stopped_answering",
      moved: [],
      waiting: [
        { kind: "app", workloadId: "prj_web", reason: "no_room" },
        { kind: "app", workloadId: "prj_theirs", reason: "no_room" },
      ],
    }),
  );
  await __settleAlertsForTest();
  assert.deepEqual(lab.capture.calls.map((c) => c.url).sort(), [
    "https://a/hook",
    "https://b/hook",
  ]);
  const titles = lab.capture.calls.map((c) =>
    String((c.body as { title?: string }).title),
  );
  assert.ok(
    titles.every((t) => !/2 Apps/.test(t)),
    "a team is told of its own App only",
  );
});

test("the cluster card lists a team's own waiting Apps, and never another team's", async () => {
  const cluster = await eu();
  lab.seq = 0;
  await web(cluster.id);
  await web(cluster.id, "prj_two");
  await web(cluster.id, "prj_theirs", TEAM_B);
  await apply(
    cluster.id,
    ...["prj_web", "prj_theirs"].map((workloadId) =>
      event(cluster.id, "placement", {
        kind: "app",
        workloadId,
        members: [""],
        epoch: 1,
      }),
    ),
  );
  assert.deepEqual(await asAdmin(() => listClusterWaiting(cluster.id)), [
    "web",
  ]);
  const note = (id: string, clusterId: string | null) =>
    asAdmin(() => appWaitingNote({ id, clusterId }));
  assert.equal(await note("prj_web", cluster.id), "Waiting for room in eu");
  assert.equal(await note("prj_two", cluster.id), null);
  assert.equal(await note("prj_web", null), null, "an App on one server");
  assert.deepEqual(
    await runWithIdentity({ userId: "user_b", teamId: TEAM_B }, () =>
      listClusterWaiting(cluster.id),
    ),
    ["prj_theirs"],
  );
});

test("a Deplo move in progress applies no failover event", async () => {
  const cluster = await eu();
  lab.seq = 0;
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
  const r = await applyLeaderEvent(
    cluster.id,
    event(cluster.id, "failed_over", {
      kind: "app",
      workloadId: "prj_web",
      from: "srv_2",
      to: "srv_3",
      reason: "stopped_answering",
    }),
  );
  assert.equal(r, "frozen");
  assert.deepEqual(await messages(), []);
});
