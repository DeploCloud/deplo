import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";

import { PostgresArchive } from "../agent/gen/agent";
import { runWithIdentity } from "../auth/request-context";
import {
  backupRuns as runsTable,
  backups as backupsTable,
} from "../db/schema/control-plane/backups";
import { databases as databasesTable } from "../db/schema/control-plane/databases";
import {
  seedBackup,
  seedDatabase,
  seedDestination,
  seedRun,
  settleProvisioning,
} from "./backup-test-helpers";
import { assembleBackup } from "./backup-rows";
import { runDatabaseBackup, runScheduledBackup } from "./backups/run-now";
import { restoreBackup } from "./backups/restore";
import {
  apply,
  asAdmin,
  backedUp,
  databaseLab,
  db,
  deploSaid,
  eu,
  event,
  failedOver,
  host,
  main,
  movedOrRestored,
  open,
  TODAY_1415,
} from "./cluster-database-test-helpers";
import {
  __forgetChangeLogWatchForTest,
  shipChangeLogs,
} from "./clusters/change-log";
import { pushDatabaseBundle } from "./clusters/database-bundles";
import { addClusterMember } from "./clusters/members";
import {
  __resetClusterWatchForTest,
  releaseClusterWatchLease,
  runClusterWatchTick,
} from "./clusters/watch-scheduler";
import { getDatabaseFailover, getFailoverPreview } from "./databases/failover";
import { rebuildDatabase } from "./databases/lifecycle";
import { createDatabase } from "./databases/provision";
import { moveDatabaseToCluster, updateDatabase } from "./databases/server-move";
import { TEAM_A, TEAM_B } from "./identity-test-helpers";

// A Postgres database on a cluster archives its change log beside its backups (spec #176, ticket #203).

const ARCHIVE = "backup.postgres-archive";
const BASE_KEY =
  "deplo/team_a/database/db_main/20260301T141500Z-brun_1.base.tar.gz.age";
const ARCHIVING =
  "services: {db-main: {command: [postgres, -c, archive_mode=on]}}";
const TODAY_1427 = TODAY_1415.replace("14:15", "14:27");

const dbRow = async (id = "db_main") =>
  (await db.select().from(databasesTable).where(eq(databasesTable.id, id)))[0]!;
const schedules = async (id = "db_main") =>
  db.select().from(backupsTable).where(eq(backupsTable.databaseId, id));
const archivedAt = (at: string | null, id = "db_main") =>
  db
    .update(databasesTable)
    .set({ walArchivedAt: at })
    .where(eq(databasesTable.id, id));

/** "main" on srv_2, archiving and counted as of a minute ago, with a base backup in the bucket taken a minute ago unless told. */
async function archiving(clusterId: string, baseAt = minutesAgo(1)) {
  await main(clusterId);
  host.srv_2.stacks["db-main"] = ARCHIVING;
  await backedUp({
    objectKey: BASE_KEY,
    startedAt: baseAt,
    finishedAt: baseAt,
  });
  await archivedAt(minutesAgo(1));
}
const minutesAgo = (m: number) =>
  new Date(Date.now() - m * 60_000).toISOString();

describe("cluster database change log", () => {
  databaseLab();
  beforeEach(() => {
    __forgetChangeLogWatchForTest();
    for (const h of Object.values(host)) h.capabilities.push(ARCHIVE);
  });

  describe("turning it on and off", () => {
    it("starts archiving when a Postgres database is placed on a cluster, with a base backup every 15 minutes", async () => {
      const cluster = await eu();
      await seedDatabase(db, {
        id: "db_main",
        name: "main",
        serverId: "srv_4",
      });

      await asAdmin(() => moveDatabaseToCluster("db_main", cluster.id));

      assert.match(host.srv_2.reroutes.at(-1)!.composeYaml, /archive_mode=on/);
      const [s] = await schedules();
      assert.equal(s!.name, "Failover backup");
      assert.equal(s!.schedule, "*/15 * * * *");
      assert.equal(s!.baseBackup, true);
    });

    it("starts archiving for a Postgres database created on a cluster", async () => {
      const cluster = await eu();

      await asAdmin(() =>
        createDatabase({
          name: "fresh",
          type: "postgres",
          version: "16",
          clusterId: cluster.id,
        }),
      );
      await settleProvisioning(db);

      assert.match(host.srv_2.reroutes.at(-1)!.composeYaml, /archive_mode=on/);
      const [made] = await db
        .select()
        .from(databasesTable)
        .where(eq(databasesTable.name, "fresh"));
      assert.equal((await schedules(made!.id))[0]!.baseBackup, true);
    });

    it("stops archiving when the database leaves the cluster", async () => {
      const cluster = await eu();
      await main(cluster.id);
      await archivedAt(minutesAgo(1));

      await asAdmin(() =>
        updateDatabase("db_main", {
          exposedPublicly: false,
          serverId: "srv_4",
        }),
      );

      assert.doesNotMatch(
        host.srv_4.reroutes.at(-1)!.composeYaml,
        /archive_mode/,
      );
      const row = await dbRow();
      assert.equal(row.clusterId, null);
      assert.equal(row.walArchivedAt, null);
    });

    it("keeps a Postgres database's own schedule as it is and adds the base backup beside it", async () => {
      const cluster = await eu();
      await seedDatabase(db, {
        id: "db_main",
        name: "main",
        serverId: "srv_4",
      });
      await seedDestination(db, { id: "dst_s3", name: "bucket" });
      await seedBackup(db, {
        id: "bkp_own",
        databaseId: "db_main",
        destinationId: "dst_s3",
      });

      await asAdmin(() => moveDatabaseToCluster("db_main", cluster.id));

      const all = await schedules();
      assert.deepEqual(all.map((s) => [s.name, s.baseBackup]).sort(), [
        ["Failover backup", true],
        ["bkp_own", false],
      ]);
    });

    it("archives nothing for another engine", async () => {
      const cluster = await eu();
      await seedDatabase(db, {
        id: "db_main",
        name: "main",
        serverId: "srv_4",
        type: "mysql",
      });

      await asAdmin(() => moveDatabaseToCluster("db_main", cluster.id));

      assert.doesNotMatch(
        host.srv_2.reroutes.at(-1)!.composeYaml,
        /archive_mode/,
      );
      assert.equal((await schedules())[0]!.baseBackup, false);
    });

    it("says a database that came with its server archives once it is redeployed", async () => {
      const cluster = await eu(["srv_2"]);
      await seedDatabase(db, {
        id: "db_main",
        name: "main",
        serverId: "srv_3",
      });
      await seedDatabase(db, {
        id: "db_my",
        name: "shop",
        serverId: "srv_3",
        type: "mysql",
      });

      await asAdmin(() => addClusterMember(cluster.id, "srv_3"));

      const said = (await deploSaid()).filter((m) => /change log/.test(m));
      assert.deepEqual(said, [
        "main archives its change log once it is redeployed. Until then a failover restores its latest backup.",
      ]);
      // Joining restarts nothing.
      assert.equal(host.srv_3.reroutes.length, 0);
    });

    it("refuses to place another team's database", async () => {
      const cluster = await eu();
      await seedDatabase(db, {
        id: "db_b",
        name: "theirs",
        serverId: "srv_4",
        teamId: TEAM_B,
      });
      await assert.rejects(() =>
        asAdmin(() => moveDatabaseToCluster("db_b", cluster.id)),
      );
      assert.equal(host.srv_2.reroutes.length, 0);
    });
  });

  describe("the base backup", () => {
    const failoverSchedule = async (over = {}) => {
      await seedDestination(db, { id: "dst_s3", name: "bucket" }).catch(
        () => {},
      );
      await seedBackup(db, {
        id: "bkp_f",
        databaseId: "db_main",
        destinationId: "dst_s3",
      });
      await db
        .update(backupsTable)
        .set({ baseBackup: true, ...over })
        .where(eq(backupsTable.id, "bkp_f"));
      return assembleBackup((await schedules())[0]!);
    };
    const runs = () =>
      db.select().from(runsTable).where(eq(runsTable.targetId, "db_main"));

    it("is what the failover schedule writes for a Postgres database on a cluster", async () => {
      const cluster = await eu();
      await main(cluster.id);

      await runScheduledBackup(await failoverSchedule());

      assert.equal(
        host.srv_2.backups[0]!.archive,
        PostgresArchive.POSTGRES_ARCHIVE_BASE,
      );
      const [run] = await runs();
      assert.equal(run!.status, "success");
      assert.match(run!.objectKey, /-brun_[^.]+\.base\.tar\.gz\.age$/);
    });

    it("stays a dump for the database's own schedules and for a backup taken by hand", async () => {
      const cluster = await eu();
      await main(cluster.id);

      await runScheduledBackup(await failoverSchedule({ baseBackup: false }));
      await asAdmin(() => runDatabaseBackup("db_main", "dst_s3"));

      assert.deepEqual(
        host.srv_2.backups.map((b) => b.archive),
        [
          PostgresArchive.POSTGRES_ARCHIVE_NONE,
          PostgresArchive.POSTGRES_ARCHIVE_NONE,
        ],
      );
      for (const r of await runs())
        assert.match(r.objectKey, /\.dump\.gz\.age$/);
    });

    it("stays a dump once the database has left the cluster, and on a server that cannot write one", async () => {
      const cluster = await eu();
      await main(cluster.id);
      const schedule = await failoverSchedule();
      host.srv_2.capabilities = host.srv_2.capabilities.filter(
        (c) => c !== ARCHIVE,
      );
      await runScheduledBackup(schedule);
      host.srv_2.capabilities.push(ARCHIVE);
      await db
        .update(databasesTable)
        .set({ clusterId: null })
        .where(eq(databasesTable.id, "db_main"));
      await runScheduledBackup(schedule);

      assert.deepEqual(
        host.srv_2.backups.map((b) => b.archive),
        [
          PostgresArchive.POSTGRES_ARCHIVE_NONE,
          PostgresArchive.POSTGRES_ARCHIVE_NONE,
        ],
      );
    });

    it("is restored by hand like any backup, without the change log", async () => {
      const cluster = await eu();
      await archiving(cluster.id);

      await asAdmin(() => restoreBackup("brun_1"));

      const [req] = host.srv_2.restores;
      assert.equal(req!.s3!.objectKey, BASE_KEY);
      assert.equal(req!.logPrefix, "");
      // Postgres is back at that backup: what it archives from here is not what was archived before.
      assert.equal((await dbRow()).walArchivedAt, null);
    });

    it("takes its change log with it when retention removes it", async () => {
      const cluster = await eu();
      await archiving(cluster.id, minutesAgo(20));
      const old = BASE_KEY.replace("brun_1", "brun_0");
      await seedRun(db, {
        id: "brun_0",
        destinationId: "dst_s3",
        databaseId: "db_main",
        objectKey: old,
        startedAt: minutesAgo(40),
      });

      await runScheduledBackup(await failoverSchedule({ retentionCount: 1 }));

      assert.deepEqual(host.srv_2.deleted, [old, `${old}.wal`]);
      assert.deepEqual(
        (await runs()).map((r) => r.id).filter((id) => id === "brun_0"),
        [],
      );
    });
  });

  describe("shipping the change log", () => {
    it("writes what Postgres archived beside the base backup, and notes when", async () => {
      const cluster = await eu();
      await archiving(cluster.id);
      const before = Date.now();

      await shipChangeLogs();

      const [req] = host.srv_2.backups;
      assert.equal(req!.archive, PostgresArchive.POSTGRES_ARCHIVE_LOG);
      assert.equal(req!.database!.container, "db-main");
      assert.match(
        req!.s3!.objectKey,
        new RegExp(`^${BASE_KEY}\\.wal/\\d{8}T\\d{6}Z\\.tar\\.gz\\.age$`),
      );
      assert.equal(req!.s3!.bucket, "deplo-backups");
      const at = Date.parse((await dbRow()).walArchivedAt!);
      assert.ok(at >= before - 1000 && at <= Date.now(), String(at));
    });

    it("is collected by the cluster tick, once a minute", async () => {
      const cluster = await eu();
      await archiving(cluster.id);
      try {
        await runClusterWatchTick();
        for (let i = 0; i < 5000 && host.srv_2.backups.length === 0; i++)
          await dbRow();
        assert.equal(host.srv_2.backups.length, 1);

        // Seconds later the tick asks for nothing: the reads give a pass, had one started, the time to run.
        await runClusterWatchTick();
        for (let i = 0; i < 200; i++) await dbRow();
        assert.equal(host.srv_2.backups.length, 1);
      } finally {
        __resetClusterWatchForTest();
        await releaseClusterWatchLease();
      }
    });

    it("counts a minute in which nothing was written", async () => {
      const cluster = await eu();
      await archiving(cluster.id);
      host.srv_2.backupBytes = 0;

      await shipChangeLogs();

      assert.ok((await dbRow()).walArchivedAt);
    });

    it("relays it to the member whose disk keeps the backups, and leaves no empty file there", async () => {
      const cluster = await eu();
      await main(cluster.id);
      host.srv_2.stacks["db-main"] = ARCHIVING;
      await seedDestination(db, {
        id: "dst_srv3",
        name: "server-3",
        kind: "server",
        serverId: "srv_3",
      });
      await backedUp({
        destinationId: "dst_srv3",
        objectKey: BASE_KEY,
        startedAt: minutesAgo(1),
      });

      await archivedAt(minutesAgo(1));

      await shipChangeLogs();

      assert.equal(host.srv_2.backups[0]!.streamOut, true);
      assert.match(
        host.srv_3.stored[0]!,
        /\.base\.tar\.gz\.age\.wal\/\d{8}T\d{6}Z\.tar\.gz\.age$/,
      );
      assert.deepEqual(host.srv_3.deleted, []);

      host.srv_2.backupBytes = 0;
      await shipChangeLogs();
      assert.deepEqual(host.srv_3.deleted, [host.srv_3.stored[1]]);
    });

    it("waits for a restart: a stack that does not archive yet ships nothing and counts nothing", async () => {
      const cluster = await eu();
      await archiving(cluster.id);
      await archivedAt(null);
      host.srv_2.stacks["db-main"] =
        "services: {db-main: {image: postgres:16-alpine}}";

      await shipChangeLogs();

      assert.equal(host.srv_2.backups.length, 0);
      assert.equal((await dbRow()).walArchivedAt, null);
    });

    it("waits for the first base backup", async () => {
      const cluster = await eu();
      await main(cluster.id);
      host.srv_2.stacks["db-main"] = ARCHIVING;
      await backedUp();

      await shipChangeLogs();

      assert.equal(host.srv_2.backups.length, 0);
      assert.equal((await dbRow()).walArchivedAt, null);
    });

    it("counts only from a base backup taken while Postgres was already archiving", async () => {
      const cluster = await eu();
      await archiving(cluster.id);
      await archivedAt(null);

      // The change log between that base backup and the redeploy was never archived: nothing is put beside it.
      await shipChangeLogs();
      assert.equal(host.srv_2.backups.length, 0);
      assert.equal((await dbRow()).walArchivedAt, null);

      const later = new Date(Date.now() + 1000).toISOString();
      await seedRun(db, {
        id: "brun_2",
        destinationId: "dst_s3",
        databaseId: "db_main",
        objectKey: BASE_KEY.replace("brun_1", "brun_2"),
        startedAt: later,
        finishedAt: later,
      });
      await shipChangeLogs();

      assert.match(
        host.srv_2.backups[0]!.s3!.objectKey,
        /brun_2\.base\.tar\.gz\.age\.wal\//,
      );
      assert.ok((await dbRow()).walArchivedAt);
    });

    it("keeps the last time when a shipment fails", async () => {
      const cluster = await eu();
      await archiving(cluster.id);
      const last = minutesAgo(2);
      await archivedAt(last);
      host.srv_2.backupError = "the bucket said no";

      await shipChangeLogs();

      assert.equal(
        Date.parse((await dbRow()).walArchivedAt!),
        Date.parse(last),
      );
    });

    it("stops counting after a silence longer than Postgres keeps the change log, until the next base backup", async () => {
      const cluster = await eu();
      await archiving(cluster.id, minutesAgo(90));
      await archivedAt(minutesAgo(45));

      await shipChangeLogs();

      assert.equal(host.srv_2.backups.length, 0);
      assert.equal((await dbRow()).walArchivedAt, null);
    });

    it("starts over after the database is rebuilt from scratch", async () => {
      const cluster = await eu();
      await archiving(cluster.id);

      await asAdmin(() => rebuildDatabase("db_main"));

      assert.equal((await dbRow()).walArchivedAt, null);
    });

    it("leaves a database alone while a backup of it runs, and one that is not on a cluster", async () => {
      const cluster = await eu();
      await archiving(cluster.id);
      await seedRun(db, {
        id: "brun_now",
        destinationId: "dst_s3",
        databaseId: "db_main",
        status: "running",
        startedAt: minutesAgo(0),
      });
      await seedDatabase(db, {
        id: "db_solo",
        name: "solo",
        serverId: "srv_4",
      });
      host.srv_4.stacks["db-solo"] = ARCHIVING;

      await shipChangeLogs();

      assert.equal(host.srv_2.backups.length + host.srv_4.backups.length, 0);
    });
  });

  describe("a failover", () => {
    it("hands the leader the latest base backup and where its change log is, not a newer dump", async () => {
      const cluster = await eu();
      await archiving(cluster.id);
      await seedRun(db, {
        id: "brun_dump",
        destinationId: "dst_s3",
        databaseId: "db_main",
        objectKey: "deplo/team_a/database/db_main/brun_dump.dump.gz",
        startedAt: new Date().toISOString(),
      });

      await pushDatabaseBundle("db_main");

      const { restore } = await open();
      assert.equal(restore!.backupId, "brun_1");
      const req = restore!.request as {
        s3: { objectKey: string };
        logPrefix: string;
      };
      assert.equal(req.s3.objectKey, BASE_KEY);
      assert.equal(req.logPrefix, `${BASE_KEY}.wal`);
    });

    it("hands the leader its latest dump while there is no base backup, as before", async () => {
      const cluster = await eu();
      await main(cluster.id);
      await backedUp();

      await pushDatabaseBundle("db_main");

      const { restore } = await open();
      const req = restore!.request as {
        s3: { objectKey: string };
        logPrefix?: string;
      };
      assert.match(req.s3.objectKey, /brun_1\.dump\.gz\.age$/);
      assert.ok(!req.logPrefix);
    });

    it("says how far the change log reached", async () => {
      const cluster = await eu();
      await archiving(cluster.id, TODAY_1415);
      await archivedAt(TODAY_1427);

      await apply(cluster.id, ...failedOver(cluster.id));

      assert.deepEqual(await movedOrRestored(), [
        "Restored main on server-3 from the backup of 14:15 and its change log up to 14:27",
      ]);
    });

    it("says only the backup for one restored from a dump, and its change log starts over", async () => {
      const cluster = await eu();
      await main(cluster.id);
      await backedUp({ startedAt: TODAY_1415 });
      await archivedAt(TODAY_1427);

      await apply(cluster.id, ...failedOver(cluster.id));

      assert.deepEqual(await movedOrRestored(), [
        "Restored main on server-3 from the backup of 14:15",
      ]);
      assert.equal((await dbRow()).walArchivedAt, null);
    });

    it("keeps counting the change log after a failover that replayed it", async () => {
      const cluster = await eu();
      await archiving(cluster.id, TODAY_1415);

      await apply(cluster.id, ...failedOver(cluster.id));

      assert.ok((await dbRow()).walArchivedAt);
    });

    it("measures how fast the restore went, for the next estimate", async () => {
      const cluster = await eu();
      await archiving(cluster.id, TODAY_1415);
      await db
        .update(runsTable)
        .set({ sizeBytes: 50_000_000 })
        .where(eq(runsTable.id, "brun_1"));
      const [placement, moved] = failedOver(cluster.id);
      moved!.data.restoreMs = 20_000;

      await apply(cluster.id, placement!, moved!);

      assert.equal((await dbRow()).restoreBytesPerSec, 2_500_000);
    });

    it("measures nothing from another team's backup", async () => {
      const cluster = await eu();
      await main(cluster.id);
      await seedDatabase(db, {
        id: "db_b",
        name: "theirs",
        serverId: "srv_2",
        teamId: TEAM_B,
      });
      await seedDestination(db, {
        id: "dst_b",
        name: "theirs",
        teamId: TEAM_B,
      });
      await seedRun(db, {
        id: "brun_b",
        teamId: TEAM_B,
        destinationId: "dst_b",
        databaseId: "db_b",
      });
      const [placement, moved] = failedOver(cluster.id);
      Object.assign(moved!.data, { backupId: "brun_b", restoreMs: 1000 });

      await apply(cluster.id, placement!, moved!);

      assert.equal((await dbRow()).restoreBytesPerSec, null);
    });
  });

  describe("what the database page says", () => {
    const page = (id = "db_main", teamId = TEAM_A) =>
      runWithIdentity(
        { userId: teamId === TEAM_A ? "user_1" : "user_b", teamId },
        () => getDatabaseFailover(id),
      );

    it("promises about a minute for a Postgres database whose change log is being archived", async () => {
      const cluster = await eu();
      await archiving(cluster.id);
      await seedBackup(db, {
        id: "bkp_f",
        databaseId: "db_main",
        destinationId: "dst_s3",
        schedule: "*/15 * * * *",
      });
      await archivedAt(minutesAgo(1));

      assert.equal(
        (await asAdmin(() => getDatabaseFailover("db_main")))!.loss,
        "A failover can lose about a minute of writes while Deplo is running: it collects the change log every minute. If Deplo is down too, the loss is everything written since it stopped.",
      );
    });

    it("keeps the backup's window until the change log is archived, and for every other engine", async () => {
      const cluster = await eu();
      await archiving(cluster.id);
      await seedBackup(db, {
        id: "bkp_f",
        databaseId: "db_main",
        destinationId: "dst_s3",
        schedule: "*/15 * * * *",
      });
      const window =
        "A failover can lose up to 15 minutes of writes: everything since the last backup.";
      await archivedAt(null);

      assert.equal(
        (await asAdmin(() => getDatabaseFailover("db_main")))!.loss,
        window,
      );

      await db
        .update(databasesTable)
        .set({ type: "mysql", walArchivedAt: minutesAgo(1) })
        .where(eq(databasesTable.id, "db_main"));
      assert.equal(
        (await asAdmin(() => getDatabaseFailover("db_main")))!.loss,
        window,
      );
    });

    it("promises about a minute in the dialog that offers a cluster, whatever its own schedule", async () => {
      await seedDatabase(db, {
        id: "db_solo",
        name: "solo",
        serverId: "srv_4",
      });
      await seedDestination(db, { id: "dst_s3", name: "bucket" });
      await seedBackup(db, {
        id: "bkp_own",
        databaseId: "db_solo",
        destinationId: "dst_s3",
      });

      assert.equal(
        (await asAdmin(() => getFailoverPreview("db_solo")))!.loss,
        "A failover can lose about a minute of writes while Deplo is running: it collects the change log every minute. If Deplo is down too, the loss is everything written since it stopped.",
      );
      assert.equal(await page("db_solo", TEAM_B), null);
    });

    it("says a database is waiting for room, and nothing to another team", async () => {
      const cluster = await eu();
      await main(cluster.id);
      await apply(
        cluster.id,
        event(cluster.id, "placement", {
          kind: "database",
          workloadId: "db_main",
          members: [""],
          epoch: 1,
        }),
      );

      assert.equal(
        (await asAdmin(() => getDatabaseFailover("db_main")))!.waiting,
        "Waiting for room in eu",
      );
      assert.equal(await page("db_main", TEAM_B), null);
    });

    it("says nothing about room while the database runs", async () => {
      const cluster = await eu();
      await main(cluster.id);
      assert.equal(
        (await asAdmin(() => getDatabaseFailover("db_main")))!.waiting,
        null,
      );
    });
  });
});
