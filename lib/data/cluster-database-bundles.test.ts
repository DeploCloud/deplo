import { test } from "node:test";
import assert from "node:assert/strict";

import { eq } from "drizzle-orm";

import { TEAM_A, TEAM_B } from "./identity-test-helpers";
import {
  seedBackup,
  seedDatabase,
  seedDestination,
  seedRun,
  settleProvisioning,
} from "./backup-test-helpers";
import { backups as backupsTable } from "../db/schema/control-plane/backups";
import {
  clusters as clustersTable,
  failoverBundlePushes,
} from "../db/schema/control-plane/clusters";
import { CLUSTER_FAILOVER_RESTORE_CAPABILITY } from "../infra/agent-client/hello-capabilities";
import { decryptSecretOrThrow } from "../crypto";
import { executeBackup } from "./backups/execute-backup";
import { recordLeftBehindRun } from "./backups/left-behind";
import {
  flushDatabaseBundles,
  pushDatabaseBundle,
  reconcileDatabaseBundles,
} from "./clusters/database-bundles";
import { forgetLeaderRoster, pushLeaderRoster } from "./clusters/leader-sync";
import { createCluster } from "./clusters/manage";
import { addClusterMember } from "./clusters/members";
import { getClusterById } from "./clusters/roster";
import { deleteDatabase } from "./databases/lifecycle";
import {
  AGE_IDENTITY,
  asAdmin,
  backedUp,
  cannot,
  databaseLab,
  db,
  deploSaid,
  eu,
  host,
  leader,
  main,
  open,
  puts,
  leaderHost,
} from "./cluster-database-test-helpers";

databaseLab();

test("a database's bundle holds its stack, its engine password, its destination's credentials and its latest backup, and nothing else", async () => {
  const cluster = await eu();
  await main(cluster.id);
  await backedUp();

  await pushDatabaseBundle("db_main");

  const b = await open();
  assert.deepEqual(Object.keys(b).sort(), [
    "deploymentId",
    "kind",
    "restore",
    "stack",
    "v",
    "workload",
  ]);
  assert.equal(b.keep, undefined, "no schedule: nowhere to save what is left");
  assert.equal(b.kind, "database");
  assert.equal(b.workload, "db_main");
  assert.equal(
    b.deploymentId,
    leader.held.get("database/db_main")!.deploymentId,
  );
  // The stack is what a member is handed to run this database: the engine reads its password from it.
  assert.deepEqual(Object.keys(b.stack).sort(), [
    "composeUpArgs",
    "composeYaml",
    "env",
    "imageRef",
    "network",
    "projectId",
    "registryAuth",
    "slug",
  ]);
  assert.equal(b.stack.slug, "db-main");
  assert.equal(b.stack.projectId, "db_main");
  assert.equal(b.stack.imageRef, "");
  assert.equal(b.stack.network, `deplo-team-${TEAM_A}`);
  assert.match(b.stack.composeYaml, /container_name: db-main/);
  assert.match(b.stack.composeYaml, /POSTGRES_PASSWORD=pw/);
  assert.deepEqual(b.stack.composeUpArgs, ["--force-recreate"]);

  const r = b.restore!;
  assert.deepEqual(Object.keys(r).sort(), ["backupId", "request", "takenAt"]);
  assert.equal(r.backupId, "brun_1");
  assert.equal(r.takenAt, "2026-03-01T14:15:00.000Z");
  const req = r.request as Record<string, Record<string, unknown>>;
  assert.equal(req.kind, "BACKUP_KIND_DATABASE");
  assert.equal(req.s3.accessKey, "AKIA_TEST");
  assert.equal(req.s3.secretKey, "secret_test");
  assert.equal(req.s3.bucket, "deplo-backups");
  assert.equal(
    req.s3.objectKey,
    "deplo/team/database/db_main/brun_1.dump.gz.age",
  );
  assert.equal(req.database.password, "pw");
  assert.equal(req.database.container, "db-main");
  assert.equal(req.database.dbType, "postgres");
  assert.equal(req.database.projectId, "db_main");
  assert.equal(req.ageIdentity, AGE_IDENTITY);
  assert.equal(req.expectedSha256, "abc123");
  assert.equal(req.store, undefined);

  // At rest here it is ciphertext under DEPLO_SECRET, and the leader is told only what it places by.
  const [row] = await db.select().from(failoverBundlePushes);
  assert.equal(row.workloadKind, "database");
  assert.ok(row.pushedAt);
  assert.doesNotMatch(row.bundleEnc, /secret_test|POSTGRES_PASSWORD/);
  assert.match(
    decryptSecretOrThrow(row.bundleEnc, "a failover bundle"),
    /secret_test/,
  );
});

test("the bundle is sent again when a new backup completes, and not when nothing changed", async () => {
  const cluster = await eu();
  await main(cluster.id);
  await backedUp();
  await pushDatabaseBundle("db_main");
  const first = leader.held.get("database/db_main")!.deploymentId;
  await pushDatabaseBundle("db_main");
  assert.equal(puts(), 1, "an unchanged bundle is not sealed and sent again");

  host.srv_2.extra.backup = async function* () {
    yield {
      result: {
        ok: true,
        error: "",
        objectKey: "",
        sizeBytes: 2048,
        sha256: "def456",
        decryptedSizeBytes: 0,
        heldMs: 0,
      },
    };
  };
  const run = await executeBackup(TEAM_A, "Deplo", {
    backupId: null,
    kind: "database",
    databaseId: "db_main",
    appId: null,
    destinationId: "dst_s3",
    retentionCount: 7,
  });
  await flushDatabaseBundles();

  const b = await open();
  assert.equal(b.restore!.backupId, run.id);
  assert.equal(b.restore!.takenAt, run.startedAt);
  const req = b.restore!.request as Record<string, Record<string, unknown>>;
  assert.equal(req.expectedSha256, "def456");
  assert.equal(req.s3.objectKey, run.objectKey);
  assert.notEqual(leader.held.get("database/db_main")!.deploymentId, first);

  // A backup that fails leaves the leader with the last good one.
  host.srv_2.extra.backup = async function* () {
    yield {
      result: {
        ok: false,
        error: "disk full",
        objectKey: "",
        sizeBytes: 0,
        sha256: "",
        decryptedSizeBytes: 0,
        heldMs: 0,
      },
    };
  };
  await assert.rejects(
    () =>
      executeBackup(TEAM_A, "Deplo", {
        backupId: null,
        kind: "database",
        databaseId: "db_main",
        appId: null,
        destinationId: "dst_s3",
        retentionCount: 7,
      }),
    /disk full/,
  );
  await flushDatabaseBundles();
  assert.equal((await open()).restore!.backupId, run.id);
});

test("a backup kept on another member's disk is restored on that member, and the bundle says which", async () => {
  const cluster = await eu();
  await main(cluster.id);
  await seedDestination(db, {
    id: "dst_srv3",
    kind: "server",
    serverId: "srv_3",
    path: "/mnt/backups",
  });
  await backedUp({ destinationId: "dst_srv3" });

  await pushDatabaseBundle("db_main");

  const r = (await open()).restore!;
  assert.equal(r.storeMember, "srv_3");
  const req = r.request as Record<string, Record<string, unknown>>;
  assert.deepEqual(req.store, {
    root: "/mnt/backups",
    objectKey: "deplo/team/database/db_main/brun_1.dump.gz.age",
  });
  assert.equal(req.s3, undefined);
  assert.equal(req.ageIdentity, AGE_IDENTITY);
  assert.deepEqual(await cannot(), []);
});

test("backups kept on the database's own server are no way back, and Activity says so once", async () => {
  const cluster = await eu();
  await main(cluster.id);
  await seedDestination(db, {
    id: "dst_srv2",
    kind: "server",
    serverId: "srv_2",
  });
  await backedUp({ destinationId: "dst_srv2" });

  await pushDatabaseBundle("db_main");
  await pushDatabaseBundle("db_main");

  const b = await open();
  assert.equal(b.restore, undefined, "the leader is handed no restore");
  assert.match(b.stack.composeYaml, /container_name: db-main/);
  assert.deepEqual(await cannot(), [
    "main cannot fail over yet: its backups are kept on server-2, the server it runs on, so they would stop with it. Pick another destination for its backup. Cluster eu will not move it to another server until that is fixed.",
  ]);
});

test("backups kept on a server outside the cluster cannot be read without Deplo, and Activity says so", async () => {
  const cluster = await eu();
  await main(cluster.id);
  await seedDestination(db, {
    id: "dst_srv4",
    kind: "server",
    serverId: "srv_4",
  });
  await backedUp({ destinationId: "dst_srv4" });

  await pushDatabaseBundle("db_main");

  assert.equal((await open()).restore, undefined);
  assert.deepEqual(await cannot(), [
    "main cannot fail over yet: its backups are kept on server-4, which is not in the cluster, so no server of the cluster can read them on its own. Keep its backup on another server of the cluster, or in a bucket. Cluster eu will not move it to another server until that is fixed.",
  ]);
});

test("the newest backup another member can read is the one restored, and never another team's or a failed one", async () => {
  const cluster = await eu();
  await main(cluster.id);
  await backedUp(); // brun_1 in the bucket
  await seedDestination(db, {
    id: "dst_srv2",
    kind: "server",
    serverId: "srv_2",
  });
  // Newer, but on the database's own server; newer still, but it failed; and one of another team under the same id.
  await seedRun(db, {
    id: "brun_2",
    destinationId: "dst_srv2",
    databaseId: "db_main",
    startedAt: "2026-03-01T14:30:00.000Z",
  });
  await seedRun(db, {
    id: "brun_3",
    destinationId: "dst_s3",
    databaseId: "db_main",
    status: "failed",
    startedAt: "2026-03-01T14:45:00.000Z",
  });
  await seedDestination(db, { id: "dst_b", teamId: TEAM_B });
  await seedRun(db, {
    id: "brun_b",
    teamId: TEAM_B,
    destinationId: "dst_b",
    targetId: "db_main",
    startedAt: "2026-03-01T15:00:00.000Z",
  });

  await pushDatabaseBundle("db_main");

  assert.equal((await open()).restore!.backupId, "brun_1");
  assert.deepEqual(await cannot(), []);
});

test("a database that arrives with its server gets the 15-minute backup once the cluster can fail over", async () => {
  await seedDatabase(db, { id: "db_main", name: "main", serverId: "srv_2" });
  const cluster = await asAdmin(() =>
    createCluster("eu", { allTeams: true, teamIds: [] }),
  );
  await asAdmin(() => addClusterMember(cluster.id, "srv_2"));
  assert.equal(
    (await db.select().from(backupsTable)).length,
    0,
    "one member: there is no other server to keep a backup on yet",
  );

  await asAdmin(() => addClusterMember(cluster.id, "srv_3"));

  const schedules = await db.select().from(backupsTable);
  assert.deepEqual(
    schedules.map((s) => [s.name, s.databaseId, s.schedule, s.enabled]),
    [["Failover backup", "db_main", "*/15 * * * *", true]],
  );
  assert.deepEqual(
    (await deploSaid()).filter((m) => /^Backs up /.test(m)),
    ["Backs up main every 15 minutes to server-3"],
  );
  // A database that already has a schedule keeps it: a third member adds none.
  await asAdmin(() => addClusterMember(cluster.id, "srv_4"));
  assert.equal((await db.select().from(backupsTable)).length, 1);
});

test("the leader is told which member's agent cannot restore a backup, and Activity names it", async () => {
  host.srv_3.capabilities = host.srv_3.capabilities.filter(
    (c) => c !== CLUSTER_FAILOVER_RESTORE_CAPABILITY,
  );
  const cluster = await eu();
  forgetLeaderRoster();
  await pushLeaderRoster((await getClusterById(cluster.id))!);

  const members = leader.rosters.at(-1)!.members;
  assert.deepEqual(
    members.map((m) => [m.id, m.noRestore ?? false, m.noFailover ?? false]),
    [
      ["srv_2", false, false],
      ["srv_3", true, false],
    ],
  );
  assert.deepEqual(
    (await deploSaid()).filter((m) => /too old/.test(m)),
    [
      "The agent on server-3 is too old to restore a database when another server in cluster eu stops. Update the agent on server-3.",
    ],
  );
});

test("a database that is deleted takes its bundle with it", async () => {
  const cluster = await eu();
  await main(cluster.id);
  await pushDatabaseBundle("db_main");
  assert.ok(leader.held.has("database/db_main"));
  host.srv_2.extra.listInstances = async () => [];

  await asAdmin(() => deleteDatabase("db_main"));
  await settleProvisioning(db);

  assert.deepEqual(leader.dropped, ["database/db_main"]);
  assert.equal((await db.select().from(failoverBundlePushes)).length, 0);
});

test("the sweep sends what changed, sends again what a leader lost, and drops what no database owns", async () => {
  const cluster = await eu();
  await main(cluster.id);
  await backedUp();
  await pushDatabaseBundle("db_main");
  const first = leader.held.get("database/db_main")!.deploymentId;

  await reconcileDatabaseBundles();
  assert.equal(puts(), 1, "nothing changed, nothing sent");

  // A new backup the push never heard of (Deplo restarted in between).
  await seedRun(db, {
    id: "brun_9",
    destinationId: "dst_s3",
    databaseId: "db_main",
    startedAt: "2026-03-01T14:30:00.000Z",
  });
  await reconcileDatabaseBundles();
  assert.equal((await open()).restore!.backupId, "brun_9");
  assert.notEqual(leader.held.get("database/db_main")!.deploymentId, first);

  // The leader lost its store, and holds a bundle for a database that is gone.
  leader.held.clear();
  leader.held.set("database/db_gone", {
    deploymentId: "rev_x",
    sealed: new Uint8Array(),
  });
  leader.held.set("app/prj_other", {
    deploymentId: "dep_x",
    sealed: new Uint8Array(),
  });
  await reconcileDatabaseBundles();
  assert.equal((await open()).restore!.backupId, "brun_9");
  assert.deepEqual(leader.dropped, ["database/db_gone"]);
  assert.ok(
    leader.held.has("app/prj_other"),
    "an App's bundle is not this sweep's",
  );
});

test("the failover backup goes to a server of the cluster before one outside it, which no failover could read", async () => {
  await seedDatabase(db, { id: "db_main", name: "main", serverId: "srv_2" });
  await seedDestination(db, {
    id: "dst_outside",
    name: "outside",
    kind: "server",
    serverId: "srv_4",
  });
  await seedDestination(db, {
    id: "dst_member",
    name: "member",
    kind: "server",
    serverId: "srv_3",
  });

  await eu();

  const [schedule] = await db.select().from(backupsTable);
  assert.equal(schedule.destinationId, "dst_member");
});

test("only the leader that leads decides a failover: one standing by that takes no bundle is put right by the sweep, not warned about", async () => {
  const cluster = await eu();
  await main(cluster.id);
  await backedUp();
  // The leader runs on srv_4; Deplo's own stands by, answers with its key and takes nothing.
  await db
    .update(clustersTable)
    .set({ leaderServerId: "srv_4" })
    .where(eq(clustersTable.id, cluster.id));
  host.srv_4.status = { ...leaderHost.status };
  host.srv_4.leader = leaderHost.leader;
  const age = await import("age-encryption");
  const standby = await age.identityToRecipient(
    await age.generateX25519Identity(),
  );
  leaderHost.leader = (method) => {
    if (method === "leader.key")
      return new TextEncoder().encode(JSON.stringify({ publicKey: standby }));
    throw new Error("the standby leader is restarting");
  };

  await pushDatabaseBundle("db_main");

  assert.equal((await open()).restore?.backupId, "brun_1");
  assert.deepEqual(await cannot(), []);

  // The leader that leads not taking it is what keeps the database from failing over.
  host.srv_4.leader = (method) => {
    if (method === "leader.key")
      return new TextEncoder().encode(
        JSON.stringify({ publicKey: leader.publicKey }),
      );
    throw new Error("no room on the leader's disk");
  };
  await backedUp({ id: "brun_2", startedAt: "2026-03-01T14:30:00.000Z" });
  await pushDatabaseBundle("db_main");
  assert.deepEqual(await cannot(), [
    "main cannot fail over yet: the cluster's leader did not take its bundle. Deplo will send it again. Cluster eu will not move it to another server until that is fixed.",
  ]);
});

test("the bundle says where a server that comes back saves what it still held: the schedule's destination, as a volume", async () => {
  const cluster = await eu();
  await main(cluster.id);
  await backedUp();
  await seedBackup(db, {
    id: "bkp_1",
    databaseId: "db_main",
    destinationId: "dst_s3",
  });

  await pushDatabaseBundle("db_main");

  const k = (await open()).keep!;
  assert.deepEqual(Object.keys(k).sort(), ["ref", "request"]);
  assert.equal(k.ref, "dst_s3");
  const req = k.request as Record<string, Record<string, unknown>>;
  assert.equal(req.kind, "BACKUP_KIND_PROJECT");
  assert.equal(req.database, undefined);
  assert.equal(req.project.slug, "db-main");
  assert.deepEqual(req.project.volumeNames, ["deplo-db-main_db-main-data"]);
  // Only where to write: the member adds the time and its own id, and the stack is not part of it.
  assert.equal(req.s3.objectKey, `deplo/${TEAM_A}/database/db_main/left`);
  assert.equal(req.s3.secretKey, "secret_test");
  assert.equal(req.project.composeYaml ?? "", "");
  assert.ok(
    req.ageRecipient,
    "encrypted like every backup of that destination",
  );
});

test("a keep on a server's disk names that server, so a member elsewhere knows it cannot write there", async () => {
  const cluster = await eu();
  await main(cluster.id);
  await seedDestination(db, {
    id: "dst_srv3",
    kind: "server",
    serverId: "srv_3",
    path: "/mnt/backups",
  });
  await seedBackup(db, {
    id: "bkp_1",
    databaseId: "db_main",
    destinationId: "dst_srv3",
  });

  await pushDatabaseBundle("db_main");

  const k = (await open()).keep!;
  assert.equal(k.storeMember, "srv_3");
  const req = k.request as Record<string, Record<string, unknown>>;
  assert.deepEqual(req.store, {
    root: "/mnt/backups",
    objectKey: `deplo/${TEAM_A}/database/db_main/left`,
  });
});

test("what a returning server left is never the backup a failover restores, however new", async () => {
  const cluster = await eu();
  await main(cluster.id);
  await backedUp();
  const left = await recordLeftBehindRun({
    teamId: TEAM_A,
    kind: "database",
    targetId: "db_main",
    destinationId: "dst_s3",
    objectKey: `deplo/${TEAM_A}/database/db_main/left-20260302T100000Z-srv_3.tar.gz.age`,
    sizeBytes: 10,
    decryptedSizeBytes: null,
    sha256: "feed",
    serverId: "srv_3",
    failedOverAt: "2026-03-02T09:00:00.000Z",
    savedAt: "2026-03-02T10:00:00.000Z",
  });
  assert.ok(left);

  await pushDatabaseBundle("db_main");

  assert.equal((await open()).restore!.backupId, "brun_1");
});
