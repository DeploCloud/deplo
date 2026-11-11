import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";

import { makeTestDb, type TestDb } from "../../db/test-harness";
import { __setTestDb, __resetTestDb } from "../../db/client";
import { runWithIdentity } from "../../auth/request-context";
import { __setAgentConnectorForTest } from "../../infra/agent-client/connect";
import { BackupKind } from "../../agent/gen/agent";
import { ALL_CAPABILITIES } from "../../types/identity";
import { leftBehindLabel } from "../../backups/left-behind";
import { seedIdentity, TEAM_A, TEAM_B, USER_1 } from "../identity-test-helpers";
import { seedApp, seedServer, SERVER_1 } from "../app-graph-test-helpers";
import {
  seedDatabase,
  seedRun,
  seedS3,
  TRUNCATE_BACKUPS,
} from "../backup-test-helpers";
import { deleteBackupRun } from "./artifact-delete";
import { asUser1, USER_DELETER, USER_RESTORER } from "./backups-test-helpers";
import { downloadBackupArtifact } from "./download";
import { recordLeftBehindRun } from "./left-behind";
import { restoreBackup } from "./restore";
import { pruneRetention } from "./retention";
import { getDatabaseBackupSummary, listBackupRuns } from "./run-listing";

const USER_B = "user_b";
const FAILED_OVER = "2026-03-03T14:32:00.000Z";
const CAME_BACK = "2026-03-03T16:00:00.000Z";

let db: TestDb;
let pg: PGlite;
let calls: { m: string; args: unknown[] }[] = [];

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
  __setAgentConnectorForTest(
    async () =>
      new Proxy(
        {},
        {
          get(_t, prop: string) {
            if (prop === "close") return () => {};
            if (prop === "then") return undefined;
            if (prop === "restore" || prop === "restoreFrom")
              return (...args: unknown[]) => {
                calls.push({ m: prop, args });
                return (async function* () {
                  yield { result: { ok: true, error: "" } };
                })();
              };
            return async (...args: unknown[]) => {
              calls.push({ m: prop, args });
              if (prop === "hello")
                return {
                  ok: true,
                  capabilities: [
                    "backup",
                    "backup-store",
                    "backup-encrypt-s3",
                    "backup-s3-args",
                    "backup-s3-read",
                  ],
                };
              return { ok: true, error: "", deleted: 1 };
            };
          },
        },
      ) as never,
  );
});

after(async () => {
  __setAgentConnectorForTest();
  __resetTestDb();
  await pg.close();
});

beforeEach(async () => {
  await pg.exec(`${TRUNCATE_BACKUPS}
    truncate table app_build_method_settings, app_build, apps, servers,
      users, teams restart identity cascade;`);
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      { id: USER_B, teamId: TEAM_B, role: "owner" },
      {
        id: USER_RESTORER,
        teamId: TEAM_A,
        role: "member",
        capabilities: ["view", "restore_backups"],
      },
      {
        id: USER_DELETER,
        teamId: TEAM_A,
        role: "member",
        capabilities: ["view", "delete_backups"],
      },
    ],
  });
  await seedServer(db);
  await seedDatabase(db, { id: "db_1", name: "main" });
  await seedApp(db, { id: "prj_1", teamId: TEAM_A });
  await seedS3(db, { id: "s3_1" });
  await db.execute(
    `update servers set agent_cert_fingerprint = 'sha256:pinned',
       agent_cert_pem = 'x', agent_version = '1.31.0'
     where id = '${SERVER_1}'`,
  );
  calls = [];
});

const asTeamB = <T>(fn: () => Promise<T>) =>
  runWithIdentity({ userId: USER_B, teamId: TEAM_B }, fn);

const key = (id: string) => `deplo/${TEAM_A}/database/db_1/${id}`;

async function seedLeft(id = "left_1"): Promise<string> {
  const runId = await recordLeftBehindRun({
    teamId: TEAM_A,
    kind: "database",
    targetId: "db_1",
    destinationId: "s3_1",
    objectKey: key(`left-20260303T160000Z-${SERVER_1}.tar.gz.age`),
    sizeBytes: 2048,
    decryptedSizeBytes: 4096,
    sha256: "ab".repeat(32),
    serverId: SERVER_1,
    failedOverAt: FAILED_OVER,
    savedAt: CAME_BACK,
  });
  assert.ok(runId, id);
  return runId;
}

const runIds = async () =>
  (
    await pg.query<{ id: string }>(`select id from backup_runs order by id`)
  ).rows.map((r) => r.id);

test("retention never counts nor deletes a run a returning server left", async () => {
  const left = await seedLeft();
  for (const [id, day] of [
    ["r_a", "01"],
    ["r_b", "02"],
  ] as const)
    await seedRun(db, {
      id,
      destinationId: "s3_1",
      databaseId: "db_1",
      objectKey: key(`${id}.gz`),
      startedAt: `2026-02-${day}T00:00:00.000Z`,
    });

  await pruneRetention(
    TEAM_A,
    {
      serverId: SERVER_1,
      kind: "database",
      targetId: "db_1",
      databaseId: "db_1",
      appId: null,
      dbType: "postgres",
      label: "main",
    },
    "s3_1",
    1,
  );

  const deleted = calls.filter((c) => c.m === "s3Delete");
  assert.equal(deleted.length, 1);
  assert.equal(
    (deleted[0]!.args[0] as { objectKey: string }).objectKey,
    key("r_a.gz"),
  );
  assert.deepEqual(await runIds(), [left, "r_b"].sort());
});

test("the list names the server it was left on and when the failover happened", async () => {
  await seedLeft();
  const [run] = await asUser1(() => listBackupRuns({ databaseId: "db_1" }));
  assert.equal(run!.leftAt, FAILED_OVER);
  assert.equal(run!.leftOnServer, "srv_1");
  assert.equal(run!.startedAt, CAME_BACK);
  assert.equal(
    leftBehindLabel(
      run!.leftOnServer,
      run!.leftAt!,
      "UTC",
      new Date("2026-03-03T18:00:00.000Z"),
    ),
    "Left on srv_1 after the failover at 14:32",
  );
  assert.equal(
    leftBehindLabel(null, FAILED_OVER, "UTC", new Date("2026-03-09T00:00:00Z")),
    "Left on a removed server after the failover at 3 Mar, 14:32",
  );
});

test("it is not the database's last backup", async () => {
  await seedRun(db, {
    id: "r_a",
    destinationId: "s3_1",
    databaseId: "db_1",
    status: "failed",
    startedAt: "2026-02-01T00:00:00.000Z",
  });
  await seedLeft();
  const s = await asUser1(() => getDatabaseBackupSummary("db_1"));
  assert.equal(s.lastRunAt, "2026-02-01T00:00:00.000Z");
  assert.equal(s.lastStatus, "failed");
});

test("a file outside the workload's own folder, or in another team's destination, is not recorded", async () => {
  const base = {
    teamId: TEAM_A,
    kind: "database" as const,
    targetId: "db_1",
    destinationId: "s3_1",
    sizeBytes: 1,
    decryptedSizeBytes: null,
    sha256: null,
    serverId: SERVER_1,
    failedOverAt: FAILED_OVER,
    savedAt: CAME_BACK,
  };
  assert.equal(
    await recordLeftBehindRun({
      ...base,
      objectKey: `deplo/${TEAM_B}/database/db_9/left-x.tar.gz`,
    }),
    null,
  );
  assert.equal(
    await recordLeftBehindRun({
      ...base,
      teamId: TEAM_B,
      objectKey: `deplo/${TEAM_B}/database/db_1/left-x.tar.gz`,
    }),
    null,
  );
  assert.deepEqual(await runIds(), []);
});

test("restoring a database's left-behind run puts its volume back and starts its stack", async () => {
  const runId = await seedLeft();
  await asUser1(() => restoreBackup(runId));
  const restore = calls.find((c) => c.m === "restore");
  assert.ok(restore, "the restore reached the server");
  const req = restore.args[0] as {
    kind: BackupKind;
    database?: unknown;
    project?: { slug: string; volumeNames: string[]; composeYaml: string };
    expectedSha256: string;
  };
  assert.equal(req.kind, BackupKind.BACKUP_KIND_PROJECT);
  assert.equal(req.database, undefined);
  assert.equal(req.project!.slug, "db-main");
  assert.deepEqual(req.project!.volumeNames, ["deplo-db-main_db-main-data"]);
  assert.match(req.project!.composeYaml, /db-main/);
  assert.equal(req.expectedSha256, "ab".repeat(32));
});

test("restore, download and delete keep their Capabilities", async () => {
  const runId = await seedLeft();
  await assert.rejects(
    () =>
      runWithIdentity({ userId: USER_DELETER, teamId: TEAM_A }, () =>
        restoreBackup(runId),
      ),
    /restore backups|permission|not allowed/i,
  );
  await assert.rejects(
    () =>
      runWithIdentity({ userId: USER_RESTORER, teamId: TEAM_A }, () =>
        deleteBackupRun(runId),
      ),
    /delete backups|permission|not allowed/i,
  );
  assert.equal(calls.filter((c) => c.m === "restore").length, 0);
  assert.deepEqual(await runIds(), [runId]);
});

test("another team cannot restore, download or delete it", async () => {
  const runId = await seedLeft();
  await assert.rejects(() => asTeamB(() => restoreBackup(runId)), /not found/i);
  await assert.rejects(
    () => asTeamB(() => downloadBackupArtifact(runId)),
    /not found/i,
  );
  await assert.rejects(
    () => asTeamB(() => deleteBackupRun(runId)),
    /not found/i,
  );
  assert.deepEqual(
    await asTeamB(() => listBackupRuns({ databaseId: "db_1" })),
    [],
  );
  assert.deepEqual(
    calls.filter((c) => c.m !== "hello"),
    [],
  );
  assert.deepEqual(await runIds(), [runId]);
});

test("a member whose reach is one other project cannot touch an App's or a database's, the folder gate included", async () => {
  const dbRun = await seedLeft();
  const appRun = await recordLeftBehindRun({
    teamId: TEAM_A,
    kind: "app",
    targetId: "prj_1",
    destinationId: "s3_1",
    objectKey: `deplo/${TEAM_A}/app/prj_1/left-20260303T160000Z-${SERVER_1}.tar.gz.age`,
    sizeBytes: 1,
    decryptedSizeBytes: null,
    sha256: null,
    serverId: SERVER_1,
    failedOverAt: FAILED_OVER,
    savedAt: CAME_BACK,
  });
  assert.ok(appRun);
  const narrowed = <T>(fn: () => Promise<T>) =>
    runWithIdentity(
      {
        userId: USER_1,
        teamId: TEAM_A,
        token: {
          id: "tok_narrow",
          capabilities: [...ALL_CAPABILITIES],
          scope: {
            teamIds: [TEAM_A],
            wholeTeamIds: [],
            projectIds: ["prc_elsewhere"],
            folderIds: [],
            appIds: [],
            appProjectIds: [],
          },
          instanceAdmin: false,
        },
      },
      fn,
    );
  for (const runId of [dbRun, appRun!]) {
    for (const act of [restoreBackup, deleteBackupRun, downloadBackupArtifact])
      await assert.rejects(
        () => narrowed<unknown>(() => act(runId)),
        /not found|permission|can't access/i,
      );
  }
  assert.deepEqual(
    await narrowed(() => listBackupRuns({ appId: "prj_1" })),
    [],
  );
  assert.deepEqual(
    calls.filter((c) => c.m !== "hello"),
    [],
  );
  assert.equal((await runIds()).length, 2);
});

test("its own team downloads it and deletes it, file included", async () => {
  const runId = await seedLeft();
  const dl = await asUser1(() => downloadBackupArtifact(runId));
  dl.close();
  assert.match(dl.filename, /\.tar\.gz$/);
  await asUser1(() => deleteBackupRun(runId));
  const deleted = calls.filter((c) => c.m === "s3Delete");
  assert.equal(deleted.length, 1);
  assert.match(
    (deleted[0]!.args[0] as { objectKey: string }).objectKey,
    /left-20260303T160000Z/,
  );
  assert.deepEqual(await runIds(), []);
});
