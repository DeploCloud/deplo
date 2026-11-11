import { test } from "node:test";
import assert from "node:assert/strict";

import { eq } from "drizzle-orm";

import { TEAM_A, TEAM_B } from "./identity-test-helpers";
import { seedApp } from "./app-graph-test-helpers";
import { seedDatabase, seedDestination } from "./backup-test-helpers";
import { backupRuns } from "../db/schema/control-plane/backups";
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
import { SERVER_1 } from "./app-graph-test-helpers";

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

async function shop(clusterId: string, teamId = TEAM_A, id = "db_shop") {
  await seedDatabase(lab.db, { id, name: "shop", serverId: "srv_3", teamId });
  await lab.db
    .update(databasesTable)
    .set({ clusterId })
    .where(eq(databasesTable.id, id));
}

const SAVED = {
  kind: "database",
  workloadId: "db_shop",
  ref: "dst_s3",
  objectKey: `deplo/${TEAM_A}/database/db_shop/left-20260303T160000Z-srv_2.tar.gz.age`,
  sizeBytes: 2048,
  decryptedSizeBytes: 4096,
  sha256: "ab".repeat(32),
  at: "2026-03-03T16:00:00.000Z",
  failedOverAt: "2026-03-03T14:32:00.000Z",
};

test("what the server saved becomes a backup marked as left on it, and the one entry and alert name it", async () => {
  const cluster = await eu();
  await shop(cluster.id);
  await seedDestination(lab.db, { id: "dst_s3", name: "bucket" });
  await asAdmin(() => saveNotificationChannel(null, hook("https://ops/hook")));
  lab.capture = captureFetch();
  lab.seq = 0;

  await applyLeaderEvent(
    cluster.id,
    event(cluster.id, "member_returned", {
      member: "srv_2",
      stopped: [{ kind: "database", workloadId: "db_shop" }],
      saved: [SAVED],
    }),
  );
  await __settleAlertsForTest();

  const body =
    "Its copy of shop was stopped: shop runs on another server now. " +
    'What it still held of shop was saved as a backup, labelled "Left on server-2".';
  assert.deepEqual(await entries(TEAM_A), [
    {
      message: `server-2 is back in cluster eu. ${body}`,
      actor: "Deplo",
      appId: null,
    },
  ]);
  assert.deepEqual(alerts(), [
    { url: "https://ops/hook", title: "server-2 is back in cluster eu", body },
  ]);
  const runs = await lab.db.select().from(backupRuns);
  assert.equal(runs.length, 1);
  const [run] = runs;
  assert.equal(run.teamId, TEAM_A);
  assert.equal(run.databaseId, "db_shop");
  assert.equal(run.targetKind, "database");
  assert.equal(run.destinationId, "dst_s3");
  assert.equal(run.objectKey, SAVED.objectKey);
  assert.equal(run.sizeBytes, 2048);
  assert.equal(run.sha256, SAVED.sha256);
  assert.equal(run.status, "success");
  assert.equal(run.backupId, null);
  assert.equal(run.leftOnServerId, "srv_2");
  assert.equal(run.leftAt, SAVED.failedOverAt);
  assert.equal(run.startedAt, SAVED.at);
});

test("what could not be saved stays on the server, and the entry and alert say why", async () => {
  const cluster = await eu();
  await shop(cluster.id);
  await web(cluster.id);
  await seedDestination(lab.db, {
    id: "dst_srv3",
    kind: "server",
    serverId: "srv_3",
  });
  await asAdmin(() => saveNotificationChannel(null, hook("https://ops/hook")));
  lab.capture = captureFetch();
  lab.seq = 0;

  await applyLeaderEvent(
    cluster.id,
    event(cluster.id, "member_returned", {
      member: "srv_2",
      stopped: [
        { kind: "database", workloadId: "db_shop" },
        { kind: "app", workloadId: "prj_web" },
      ],
      kept: [
        {
          kind: "database",
          workloadId: "db_shop",
          ref: "dst_srv3",
          reason: "store_elsewhere",
        },
        {
          kind: "app",
          workloadId: "prj_web",
          reason: "backup_failed",
          error: "no space left on device",
        },
      ],
    }),
  );
  await __settleAlertsForTest();

  const body =
    "Its copies of shop and web were stopped: they run on other servers now. " +
    "What it still held of shop could not be saved as a backup, so it stays on server-2: its backups are kept on server-3, and server-2 could not send it there. " +
    "What it still held of web could not be saved as a backup, so it stays on server-2: the backup failed (no space left on device). " +
    "server-2 tries again on its own, and Activity says when it is saved.";
  assert.equal(
    (await entries(TEAM_A))[0].message,
    `server-2 is back in cluster eu. ${body}`,
  );
  assert.equal(alerts()[0].body, body);
  assert.deepEqual(await lab.db.select().from(backupRuns), []);
});

test("a saved file is recorded only for the team that owns the workload, in its own destination and folder", async () => {
  const cluster = await eu();
  await shop(cluster.id, TEAM_B, "db_theirs");
  await shop(cluster.id);
  await seedDestination(lab.db, { id: "dst_s3", name: "bucket" });
  await seedDestination(lab.db, { id: "dst_b", teamId: TEAM_B });
  lab.seq = 0;

  await applyLeaderEvent(
    cluster.id,
    event(cluster.id, "member_returned", {
      member: "srv_2",
      stopped: [
        { kind: "database", workloadId: "db_shop" },
        { kind: "database", workloadId: "db_theirs" },
      ],
      saved: [
        // Team A's database with team B's destination, then with team B's folder: neither is listed.
        { ...SAVED, ref: "dst_b" },
        {
          ...SAVED,
          objectKey: `deplo/${TEAM_B}/database/db_theirs/left-x.tar.gz`,
        },
        // Team B's own, as it should be.
        {
          ...SAVED,
          workloadId: "db_theirs",
          ref: "dst_b",
          objectKey: `deplo/${TEAM_B}/database/db_theirs/left-20260303T160000Z-srv_2.tar.gz.age`,
        },
      ],
    }),
  );

  const runs = await lab.db.select().from(backupRuns);
  assert.deepEqual(
    runs.map((r) => [r.teamId, r.databaseId, r.destinationId]),
    [[TEAM_B, "db_theirs", "dst_b"]],
  );
  assert.match(
    (await entries(TEAM_A))[0].message,
    /What it still held of shop was saved, but Deplo could not match the file to shop's backups, so it is not listed\.$/,
  );
  assert.match(
    (await entries(TEAM_B))[0].message,
    /What it still held of shop was saved as a backup, labelled "Left on server-2"\.$/,
  );
  assert.doesNotMatch((await entries(TEAM_B))[0].message, /could not/);
});

test("data that stays for a reason no retry fixes says so and promises nothing", async () => {
  const cluster = await eu();
  await shop(cluster.id);
  await web(cluster.id);
  // The team keeps its backups on a server that is not in the cluster.
  await seedDestination(lab.db, {
    id: "dst_out",
    kind: "server",
    serverId: SERVER_1,
  });
  lab.seq = 0;

  await applyLeaderEvent(
    cluster.id,
    event(cluster.id, "member_returned", {
      member: "srv_2",
      stopped: [
        { kind: "database", workloadId: "db_shop" },
        { kind: "app", workloadId: "prj_web" },
      ],
      kept: [
        {
          kind: "database",
          workloadId: "db_shop",
          ref: "dst_out",
          reason: "store_elsewhere",
        },
        { kind: "app", workloadId: "prj_web", reason: "no_destination" },
      ],
    }),
  );

  assert.equal(
    (await entries(TEAM_A))[0].message,
    "server-2 is back in cluster eu. Its copies of shop and web were stopped: they run on other servers now. " +
      `What it still held of shop could not be saved as a backup, so it stays on server-2: its backups are kept on ${SERVER_1}, which is not in cluster eu. ` +
      "What it still held of web could not be saved as a backup, so it stays on server-2: the cluster had no backup destination for it.",
  );
});

const saves = async (teamId: string) =>
  (await lab.db.select().from(activities))
    .filter(
      (a) =>
        a.teamId === teamId && / saved what it still held /.test(a.message),
    )
    .map((a) => ({ message: a.message, actor: a.actor }));

test("data saved after the return becomes a left-behind backup and one Activity line, with no second alert", async () => {
  const cluster = await eu();
  await shop(cluster.id);
  await seedDestination(lab.db, { id: "dst_s3", name: "bucket" });
  await asAdmin(() => saveNotificationChannel(null, hook("https://ops/hook")));
  lab.capture = captureFetch();
  lab.seq = 0;

  await applyLeaderEvent(
    cluster.id,
    event(cluster.id, "member_returned", {
      member: "srv_2",
      stopped: [{ kind: "database", workloadId: "db_shop" }],
      kept: [
        {
          kind: "database",
          workloadId: "db_shop",
          ref: "dst_s3",
          reason: "backup_failed",
          error: "the bucket did not answer",
        },
      ],
    }),
  );
  await __settleAlertsForTest();
  // Nothing is listed while the file does not exist.
  assert.deepEqual(await lab.db.select().from(backupRuns), []);
  assert.equal(lab.capture.calls.length, 1);

  const later = event(cluster.id, "left_saved", {
    member: "srv_2",
    saved: [{ ...SAVED, at: "2026-03-03T18:20:00.000Z" }],
  });
  assert.equal(await applyLeaderEvent(cluster.id, later), "applied");
  await __settleAlertsForTest();

  assert.deepEqual(await saves(TEAM_A), [
    {
      message:
        'server-2 saved what it still held of shop as a backup, labelled "Left on server-2".',
      actor: "Deplo",
    },
  ]);
  assert.equal(lab.capture.calls.length, 1, "no second alert");
  const runs = await lab.db.select().from(backupRuns);
  assert.equal(runs.length, 1);
  const [run] = runs;
  assert.equal(run.databaseId, "db_shop");
  assert.equal(run.destinationId, "dst_s3");
  assert.equal(run.objectKey, SAVED.objectKey);
  assert.equal(run.leftOnServerId, "srv_2");
  // Labelled with the failover, not with the hour it was finally saved; and no schedule owns it.
  assert.equal(run.leftAt, SAVED.failedOverAt);
  assert.equal(run.startedAt, "2026-03-03T18:20:00.000Z");
  assert.equal(run.backupId, null);

  // Replayed after a reconnect: said once, listed once.
  assert.equal(await applyLeaderEvent(cluster.id, later), "skipped");
  assert.equal((await saves(TEAM_A)).length, 1);
  assert.equal((await lab.db.select().from(backupRuns)).length, 1);
});

test("a late save is listed only for the team that owns the workload, in its own destination, and never for another cluster's", async () => {
  const cluster = await eu();
  await shop(cluster.id, TEAM_B, "db_theirs");
  await shop(cluster.id);
  // A database of the same team that is in no cluster.
  await seedDatabase(lab.db, {
    id: "db_solo",
    name: "solo",
    serverId: "srv_3",
  });
  await seedDestination(lab.db, { id: "dst_s3", name: "bucket" });
  await seedDestination(lab.db, { id: "dst_b", teamId: TEAM_B });
  lab.seq = 0;

  await applyLeaderEvent(
    cluster.id,
    event(cluster.id, "left_saved", {
      member: "srv_2",
      saved: [
        // Team A's database pointed at team B's destination, and at team B's folder.
        { ...SAVED, ref: "dst_b" },
        {
          ...SAVED,
          objectKey: `deplo/${TEAM_B}/database/db_theirs/left-x.tar.gz`,
        },
        // A workload this cluster does not hold.
        {
          ...SAVED,
          workloadId: "db_solo",
          objectKey: `deplo/${TEAM_A}/database/db_solo/left-20260303T143200Z-srv_2.tar.gz.age`,
        },
      ],
    }),
  );

  assert.deepEqual(await lab.db.select().from(backupRuns), []);
  assert.deepEqual(await saves(TEAM_B), []);
  assert.deepEqual(await saves(TEAM_A), [
    {
      message:
        "server-2 saved what it still held of shop, but Deplo could not match the file to shop's backups, so it is not listed.",
      actor: "Deplo",
    },
  ]);
});
