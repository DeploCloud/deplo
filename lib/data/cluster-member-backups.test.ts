import { afterEach, test } from "node:test";
import assert from "node:assert/strict";

import { eq } from "drizzle-orm";

import {
  backupDestination,
  backupRuns,
  backups,
} from "../db/schema/control-plane/backups";
import { clusterMembers } from "../db/schema/control-plane/clusters";
import type { AgentConnection } from "../infra/agent-client/connection";
import {
  BACKUP_CAPABILITY,
  BACKUP_STORE_CAPABILITY,
} from "../infra/agent-client/hello-capabilities";
import {
  clearMetricsHistory,
  recordMetricsSample,
} from "../monitoring/history";
import { seedBackup, seedDestination, seedRun } from "./backup-test-helpers";
import { removeClusterMember } from "./clusters/dissolve";
import { runEmptyingPass } from "./clusters/empty";
import type { ServerMetrics } from "./monitoring";
import { removeServer } from "./servers/removal";
import {
  activity,
  asAdmin,
  db,
  emptyLab,
  eu,
  hosts,
  member,
  runningApp,
} from "./cluster-empty-test-helpers";

// c48: eu-4 left cluster eu with 4 recent restore points of fise and memos still on its disk, and they were lost.
emptyLab();

afterEach(() => {
  for (const id of ["srv_2", "srv_3", "srv_4"]) clearMetricsHistory(id);
});

const KEY = "deplo/team_a/app/web/run_1.tar.gz.age";
const BYTES = Buffer.from("hello");

const isMember = async (serverId: string) =>
  (
    await db
      .select({ id: clusterMembers.serverId })
      .from(clusterMembers)
      .where(eq(clusterMembers.serverId, serverId))
  ).length > 0;

const disk = (serverId: string, used: number) =>
  recordMetricsSample({
    serverId,
    online: true,
    diskUsed: used,
    diskTotal: 1000,
    ts: Date.now(),
  } as ServerMetrics);

/** web runs on srv_3; srv_2 keeps one of its backups; srv_4 has the most disk free. */
async function keptOnSrv2() {
  await runningApp("web", "srv_3");
  const cluster = await eu(["srv_2", "srv_3", "srv_4"]);
  await seedDestination(db, { id: "dst_2", kind: "server", serverId: "srv_2" });
  await seedRun(db, {
    id: "run_1",
    destinationId: "dst_2",
    targetKind: "app",
    appId: "web",
    objectKey: KEY,
    sizeBytes: BYTES.length,
  });
  for (const id of ["srv_2", "srv_3", "srv_4"])
    hosts
      .get(id)!
      .capabilities.push(BACKUP_CAPABILITY, BACKUP_STORE_CAPABILITY);
  hosts.get("srv_2")!.extra.readStoreFile = async function* () {
    yield BYTES;
  } as AgentConnection["readStoreFile"];
  disk("srv_3", 500);
  disk("srv_4", 200);
  return cluster;
}

async function runOf(id: string) {
  const [r] = await db.select().from(backupRuns).where(eq(backupRuns.id, id));
  return r!;
}

test("a leaving member's backups move to the roomiest other member, checked, before it leaves, and Activity counts them", async () => {
  const cluster = await keptOnSrv2();
  await asAdmin(() => removeClusterMember(cluster.id, "srv_2"));
  assert.ok(await isMember("srv_2"), "it waits for its backups to move");
  await runEmptyingPass();

  assert.equal(await isMember("srv_2"), false, "it left once they moved");
  const run = await runOf("run_1");
  const [dest] = await db
    .select()
    .from(backupDestination)
    .where(eq(backupDestination.id, run.destinationId));
  const [from] = await db
    .select()
    .from(backupDestination)
    .where(eq(backupDestination.id, "dst_2"));
  assert.equal(dest?.serverId, "srv_4", "the member with the most disk free");
  assert.equal(dest?.ageRecipient, from?.ageRecipient, "the same key reads it");
  assert.deepEqual(hosts.get("srv_4")!.stored, [KEY]);
  assert.deepEqual(hosts.get("srv_2")!.deleted, [KEY]);
  const said = await activity();
  assert.ok(
    said.includes(
      "user_1: Started removing server srv_2 from cluster eu: 1 backup to move first",
    ),
  );
  assert.ok(
    said.includes(
      "Deplo: Moved 1 backup of web from srv_2 to srv_4, as srv_2 leaves cluster eu.",
    ),
  );
});

test("a backup that does not land whole stops the removal, says why, and can still be forced", async () => {
  const cluster = await keptOnSrv2();
  const sink = hosts.get("srv_4")!;
  sink.extra.writeStoreFile = async (store, _o, chunks) => {
    for await (const c of chunks) void c;
    sink.stored.push(store.objectKey);
    return { ok: true, error: "", bytesWritten: 3, sha256: "" };
  };
  await asAdmin(() => removeClusterMember(cluster.id, "srv_2"));
  await runEmptyingPass();

  assert.ok(await isMember("srv_2"), "it stays while its backup did not move");
  assert.equal(
    (await member("srv_2")).emptyingError,
    `The backup of web (5 B) did not move from srv_2 to srv_4: 3 of its 5 bytes landed. "Remove anyway" leaves its backups on srv_2.`,
  );
  assert.equal((await runOf("run_1")).destinationId, "dst_2");
  assert.deepEqual(sink.deleted, [KEY], "the short copy is deleted");
  assert.deepEqual(hosts.get("srv_2")!.deleted, [], "the backup is kept");

  await asAdmin(() =>
    removeClusterMember(cluster.id, "srv_2", { leaveBackups: true }),
  );
  assert.equal(await isMember("srv_2"), false);
  assert.equal((await runOf("run_1")).destinationId, "dst_2");
  assert.ok(
    (await activity()).includes(
      "user_1: Removed server srv_2 from cluster eu, leaving 1 backup of the cluster's Apps and databases on it",
    ),
  );
});

test("removing the server of a member that keeps its cluster's backups is refused with what to do", async () => {
  await keptOnSrv2();
  await assert.rejects(
    asAdmin(() => removeServer("srv_2")),
    {
      message:
        "srv_2 keeps 1 backup of the Apps and databases of cluster eu. Remove it from the cluster first: Deplo moves them to its other servers.",
    },
  );
  assert.ok(await isMember("srv_2"));
});

// c50: lab-kit-b's next runs were still headed for eu-4 while eu-4 was being emptied.
test("Deplo's own backup schedule leaves a member the moment its removal starts", async () => {
  const cluster = await keptOnSrv2();
  await seedBackup(db, {
    id: "bkp_web",
    targetKind: "app",
    appId: "web",
    destinationId: "dst_2",
  });
  await db
    .update(backups)
    .set({ name: "Failover backup" })
    .where(eq(backups.id, "bkp_web"));
  await asAdmin(() => removeClusterMember(cluster.id, "srv_2"));
  const [b] = await db
    .select({ serverId: backupDestination.serverId })
    .from(backups)
    .innerJoin(
      backupDestination,
      eq(backupDestination.id, backups.destinationId),
    )
    .where(eq(backups.id, "bkp_web"));
  assert.equal(b?.serverId, "srv_4");
  assert.ok(
    await isMember("srv_2"),
    "still leaving: its kept backup moves at the next pass",
  );
});
