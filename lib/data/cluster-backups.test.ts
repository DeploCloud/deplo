import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { eq } from "drizzle-orm";

import { __stopBackupScheduler, runSchedulerTick } from "../backups/scheduler";
import { backupRuns as backupRunsTable } from "../db/schema/control-plane/backups";
import { runWithIdentity } from "../auth/request-context";
import type { AgentConnection } from "../infra/agent-client/connection";
import {
  BACKUP_CAPABILITY,
  BACKUP_ENCRYPT_S3_CAPABILITY,
  BACKUP_S3_READ_CAPABILITY,
  BACKUP_STORE_CAPABILITY,
} from "../infra/agent-client/hello-capabilities";
import { SERVER_1 } from "./app-graph-test-helpers";
import {
  seedBackup,
  seedDestination,
  seedRun,
  TRUNCATE_BACKUPS,
} from "./backup-test-helpers";
import { downloadBackupArtifact } from "./backups/download";
import { restoreBackup } from "./backups/restore";
import { listBackupRuns } from "./backups/run-listing";
import { listBackups } from "./backups/schedules";
import { failoverLab } from "./cluster-failover-test-helpers";
import { TEAM_B } from "./identity-test-helpers";

const lab = failoverLab();
const { asAdmin, eu, web, event, apply } = lab;
const APP = "prj_web";
const KEY = `deplo/team/app/${APP}/brun_1.tar.gz.age`;

/** What each server's agent was asked to read from a destination, and to restore from bytes handed to it. */
let read: string[];
let restoredFrom: string[];

beforeEach(async () => {
  await lab.db.execute(TRUNCATE_BACKUPS);
  read = [];
  restoredFrom = [];
  for (const [id, host] of [
    [SERVER_1, lab.leader],
    ["srv_2", lab.members.srv_2],
    ["srv_3", lab.members.srv_3],
  ] as const) {
    host.capabilities.push(
      BACKUP_CAPABILITY,
      BACKUP_STORE_CAPABILITY,
      BACKUP_ENCRYPT_S3_CAPABILITY,
      BACKUP_S3_READ_CAPABILITY,
    );
    host.extra = {
      readStoreFile: async function* (from: {
        store?: { objectKey: string };
        s3?: { objectKey: string };
      }) {
        read.push(`${id}: ${from.store?.objectKey ?? from.s3?.objectKey}`);
        yield Buffer.from("artifact");
      },
      restoreFrom: async function* (
        _req: unknown,
        chunks: AsyncIterable<Buffer>,
      ) {
        let bytes = "";
        for await (const c of chunks) bytes += c.toString();
        restoredFrom.push(`${id}: ${bytes}`);
        yield { result: { ok: true, error: "" } };
      },
    } as unknown as Partial<AgentConnection>;
  }
});

afterEach(() => __stopBackupScheduler());

/** "web" on srv_2 of "eu", with a schedule and two finished backups in `destinationId`. */
async function backedUp(destinationId: string) {
  const cluster = await eu();
  lab.seq = 0;
  await web(cluster.id);
  await seedBackup(lab.db, {
    id: "bkp_1",
    targetKind: "app",
    appId: APP,
    destinationId,
    schedule: "* * * * *",
  });
  for (const [id, startedAt] of [
    ["brun_1", "2026-11-10T10:00:00.000Z"],
    ["brun_2", "2026-11-10T10:15:00.000Z"],
  ])
    await seedRun(lab.db, {
      id,
      backupId: "bkp_1",
      targetKind: "app",
      appId: APP,
      destinationId,
      objectKey: `deplo/team/app/${APP}/${id}.tar.gz.age`,
      startedAt,
      finishedAt: startedAt,
    });
  return cluster;
}

/** srv_2 stops for good and the leader starts "web" on srv_3. */
async function failOver(clusterId: string) {
  lab.members.srv_2.unreachable = true;
  lab.startedOn("srv_3");
  await apply(
    clusterId,
    event(clusterId, "placement", {
      kind: "app",
      workloadId: APP,
      members: ["srv_3"],
      epoch: 1,
    }),
    event(clusterId, "failed_over", {
      kind: "app",
      workloadId: APP,
      from: "srv_2",
      to: "srv_3",
      reason: "stopped_answering",
    }),
  );
}

const lists = () =>
  asAdmin(async () => ({
    runs: await listBackupRuns({ appId: APP }),
    schedules: await listBackups(),
  }));

test("an App's backups read the same before and after a failover", async () => {
  await seedDestination(lab.db, { id: "dst_s3", name: "bucket" });
  const cluster = await backedUp("dst_s3");
  const before = await lists();
  assert.deepEqual(
    before.runs.map((r) => r.id),
    ["brun_2", "brun_1"],
  );
  assert.equal(before.schedules[0].targetServerId, "srv_2");

  await failOver(cluster.id);

  const after = await lists();
  assert.deepEqual(after.runs, before.runs);
  // The schedule is the same row; only where its App runs now moved.
  assert.deepEqual(after.schedules, [
    { ...before.schedules[0], targetServerId: "srv_3" },
  ]);
});

test("a backup in a bucket taken on the old member downloads and restores through the new one", async () => {
  await seedDestination(lab.db, { id: "dst_s3", name: "bucket" });
  const cluster = await backedUp("dst_s3");
  await failOver(cluster.id);

  const dl = await asAdmin(() => downloadBackupArtifact("brun_1"));
  for await (const chunk of dl.chunks) assert.equal(String(chunk), "artifact");
  dl.close();
  assert.deepEqual(read, [`srv_3: ${KEY}`]);

  await asAdmin(() => restoreBackup("brun_1"));
  assert.deepEqual(
    lab.members.srv_3.restores.map((r) => r.s3?.objectKey),
    [KEY],
  );
  assert.deepEqual(lab.members.srv_2.restores, []);
});

test("a backup kept on a server's disk is read where it lives, and restored where the App runs now", async () => {
  await seedDestination(lab.db, {
    id: "dst_disk",
    name: "disk",
    kind: "server",
    serverId: SERVER_1,
    path: "/var/backups",
  });
  const cluster = await backedUp("dst_disk");
  await failOver(cluster.id);

  const dl = await asAdmin(() => downloadBackupArtifact("brun_1"));
  for await (const chunk of dl.chunks) assert.equal(String(chunk), "artifact");
  dl.close();
  assert.deepEqual(read, [`${SERVER_1}: ${KEY}`]);

  await asAdmin(() => restoreBackup("brun_1"));
  assert.deepEqual(read, [`${SERVER_1}: ${KEY}`, `${SERVER_1}: ${KEY}`]);
  assert.deepEqual(restoredFrom, ["srv_3: artifact"]);
});

test("the next scheduled backup after a failover is taken by the new member", async () => {
  await seedDestination(lab.db, { id: "dst_s3", name: "bucket" });
  const cluster = await backedUp("dst_s3");
  await failOver(cluster.id);

  await runSchedulerTick(new Date("2026-11-10T10:30:00.000Z"));

  assert.equal(lab.members.srv_3.backups.length, 1);
  assert.equal(lab.members.srv_3.backups[0].project?.slug, APP);
  assert.deepEqual(lab.members.srv_2.backups, []);
  const runs = await lab.db
    .select()
    .from(backupRunsTable)
    .where(eq(backupRunsTable.appId, APP));
  assert.equal(runs.length, 3);
  assert.equal(
    runs.filter((r) => r.backupId === "bkp_1" && r.status === "success").length,
    3,
  );
});

test("another team reads none of the App's backups and can neither download nor restore one", async () => {
  await seedDestination(lab.db, { id: "dst_s3", name: "bucket" });
  const cluster = await backedUp("dst_s3");
  await failOver(cluster.id);
  const asTeamB = <T>(fn: () => Promise<T>) =>
    runWithIdentity({ userId: "user_b", teamId: TEAM_B }, fn);

  assert.deepEqual(await asTeamB(() => listBackupRuns({ appId: APP })), []);
  assert.deepEqual(await asTeamB(() => listBackups()), []);
  await assert.rejects(
    asTeamB(() => downloadBackupArtifact("brun_1")),
    /Backup run not found/,
  );
  await assert.rejects(
    asTeamB(() => restoreBackup("brun_1")),
    /Backup run not found/,
  );
  assert.deepEqual(read, []);
  assert.deepEqual(lab.members.srv_3.restores, []);
});
