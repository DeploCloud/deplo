import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../../db/test-harness";
import { __setTestDb, __resetTestDb } from "../../db/client";
import { backupRuns } from "../../db/schema/control-plane/backups";
import { appVolumes } from "../../db/schema/control-plane/apps";
import { activities } from "../../db/schema/control-plane/activity";
import { seedRun } from "../backup-test-helpers";
import { asUser1, seedBase } from "./backups-test-helpers";
import { runAppBackup } from "./run-now";
import { failEmptyAppBackups } from "./empty-archive";
import { buildTar } from "../../infra/tar-test-helpers";
import { __setAgentConnectorForTest } from "../../infra/agent-client/connect";
import type { AgentConnection } from "../../infra/agent-client/connection";
import {
  BACKUP_CAPABILITY,
  BACKUP_ENCRYPT_S3_CAPABILITY,
  BACKUP_S3_READ_CAPABILITY,
} from "../../infra/agent-client/hello-capabilities";

let db: TestDb;
let pg: PGlite;

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
});

after(async () => {
  __setAgentConnectorForTest();
  __resetTestDb();
  await pg.close();
});

beforeEach(async () => {
  await seedBase(db, pg);
  await pg.exec("truncate table activities");
  await db.insert(appVolumes).values({
    appId: "prj_1",
    position: 0,
    volumeId: "vol_1",
    type: "named",
    name: "data",
    mountPath: "/data",
    readOnly: false,
  });
});

const EMPTY = buildTar([["snapshot/compose.yml", "services: {}\n"]]);
const FULL = buildTar([
  ["volumes/prj_1_data/memos.db", "rows"],
  ["snapshot/compose.yml", "services: {}\n"],
]);

function agent(a: { running: boolean; archive: Buffer; deleted?: string[] }) {
  __setAgentConnectorForTest(async () => {
    const conn = {
      hello: async () => ({
        capabilities: [
          BACKUP_CAPABILITY,
          BACKUP_ENCRYPT_S3_CAPABILITY,
          BACKUP_S3_READ_CAPABILITY,
        ],
      }),
      listInstances: async () => [{ name: "prj_1-web-1", running: a.running }],
      readStack: async () => ({ exists: false, yaml: "" }),
      async *backup() {
        yield { result: { ok: true, error: "", sizeBytes: 398, sha256: "" } };
      },
      async *readStoreFile() {
        yield gzipSync(a.archive);
      },
      s3Delete: async (t: unknown) => {
        a.deleted?.push(JSON.stringify(t));
        return { ok: true, error: "", deleted: 1 };
      },
      close: () => {},
    };
    return conn as unknown as AgentConnection;
  });
}

const said = async () =>
  (await db.select({ m: activities.message }).from(activities)).map((a) => a.m);

// c43: memos was stopped on eu-2 by a stale leader, and its backup there kept 398 B of nothing.
test("an App that does not run on its server is skipped, said once, and leaves no run", async () => {
  agent({ running: false, archive: FULL });
  await asUser1(async () => {
    await assert.rejects(
      () => runAppBackup("prj_1", "s3_1"),
      /^Error: Skipped/,
    );
    await assert.rejects(
      () => runAppBackup("prj_1", "s3_1"),
      /^Error: Skipped/,
    );
  });
  assert.equal((await db.select().from(backupRuns)).length, 0);
  const lines = await said();
  assert.equal(lines.length, 1, lines.join("\n"));
  assert.match(lines[0]!, /it is not running on .* right now/);
});

test("an archive with no file of the App's data fails and is removed, never kept", async () => {
  const deleted: string[] = [];
  agent({ running: true, archive: EMPTY, deleted });
  await asUser1(() =>
    assert.rejects(() => runAppBackup("prj_1", "s3_1"), /holds no file/),
  );
  const [run] = await db.select().from(backupRuns);
  assert.equal(run!.status, "failed");
  assert.equal(deleted.length, 1);
  assert.ok(deleted[0]!.includes(run!.objectKey), deleted[0]);
});

test("an empty archive never takes a good backup's retention slot", async () => {
  await seedRun(db, {
    id: "brun_good",
    destinationId: "s3_1",
    targetKind: "app",
    appId: "prj_1",
    startedAt: "2026-11-24T00:00:00.000Z",
  });
  agent({ running: true, archive: EMPTY, deleted: [] });
  // Ad hoc runs keep 50; a full count of good ones is what an empty run would push one out of.
  for (let i = 0; i < 49; i++)
    await seedRun(db, {
      id: `brun_${i}`,
      destinationId: "s3_1",
      targetKind: "app",
      appId: "prj_1",
      startedAt: new Date(Date.UTC(2026, 10, 25, 0, i)).toISOString(),
    });
  await asUser1(() => runAppBackup("prj_1", "s3_1").catch(() => {}));
  // The next good run prunes, counting what the empty one left as kept.
  agent({ running: true, archive: FULL, deleted: [] });
  await asUser1(() => runAppBackup("prj_1", "s3_1"));
  const good = await db
    .select()
    .from(backupRuns)
    .where(eq(backupRuns.id, "brun_good"));
  assert.equal(good.length, 1);
});

test("an archive that holds the App's data is kept", async () => {
  agent({ running: true, archive: FULL });
  await asUser1(() => runAppBackup("prj_1", "s3_1"));
  const [run] = await db.select().from(backupRuns);
  assert.equal(run!.status, "success");
});

test("a kept backup with an empty archive turns failed, once, and a full one stays", async () => {
  await seedRun(db, {
    id: "brun_empty",
    destinationId: "s3_1",
    targetKind: "app",
    appId: "prj_1",
    sizeBytes: 398,
  });
  agent({ running: true, archive: EMPTY });
  assert.equal(await failEmptyAppBackups(), 1);
  assert.equal(await failEmptyAppBackups(), 0);
  const [run] = await db.select().from(backupRuns);
  assert.equal(run!.status, "failed");
  assert.match(run!.error!, /holds no file of prj_1's data/);
  assert.equal((await said()).length, 1);

  await seedRun(db, {
    id: "brun_full",
    destinationId: "s3_1",
    targetKind: "app",
    appId: "prj_1",
    sizeBytes: 900,
  });
  agent({ running: true, archive: FULL });
  assert.equal(await failEmptyAppBackups(), 0);
  const [full] = await db
    .select()
    .from(backupRuns)
    .where(eq(backupRuns.id, "brun_full"));
  assert.equal(full!.status, "success");
});
