import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../../db/test-harness";
import { __setTestDb, __resetTestDb } from "../../db/client";
import { backups as backupsTable } from "../../db/schema/control-plane/backups";
import { seedBackup } from "../backup-test-helpers";
import { asUser1, seedBase } from "./backups-test-helpers";
import { runBackup, runDatabaseBackup } from "./run-now";
import { listBackupRuns } from "./run-listing";
import { status as GrpcStatus } from "@grpc/grpc-js";
import { LINK_OFFLINE_MESSAGE } from "../../agent-reachability";
import { __setAgentConnectorForTest } from "../../infra/agent-client/connect";
import type { AgentConnection } from "../../infra/agent-client/connection";
import { AgentUnreachableError } from "../../infra/agent-client/errors";
import {
  BACKUP_CAPABILITY,
  BACKUP_ENCRYPT_S3_CAPABILITY,
} from "../../infra/agent-client/hello-capabilities";

let db: TestDb;
let pg: PGlite;

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
});

after(async () => {
  __resetTestDb();
  await pg.close();
});

beforeEach(() => seedBase(db, pg));

test("runBackup records a failed run when the owning agent is unreachable", async () => {
  await seedBackup(db, {
    id: "bkp_1",
    destinationId: "s3_1",
    databaseId: "db_1",
  });
  await asUser1(async () => {
    await assert.rejects(() => runBackup("bkp_1"));
    const runs = await listBackupRuns({ databaseId: "db_1" });
    assert.equal(runs.length, 1, "the run was recorded (start tx)");
    assert.equal(runs[0]!.status, "failed", "flipped failed (terminal tx)");
    assert.ok(runs[0]!.finishedAt, "finishedAt stamped");
  });
  const b = (
    await db.select().from(backupsTable).where(eq(backupsTable.id, "bkp_1"))
  )[0]!;
  assert.equal(b.lastStatus, "failed");
  assert.ok(b.lastRunAt, "lastRunAt stamped by the start tx");
});

test("runDatabaseBackup refuses a target or destination this team does not own", async () => {
  await asUser1(async () => {
    await assert.rejects(
      () => runDatabaseBackup("db_missing", "s3_1"),
      /Database not found/,
    );
    await assert.rejects(
      () => runDatabaseBackup("db_1", "s3_missing"),
      /Select a destination/,
    );
  });
});

test("runDatabaseBackup records a failed run rather than throwing past the executor", async () => {
  await asUser1(async () => {
    await assert.rejects(() => runDatabaseBackup("db_1", "s3_1"));
    const runs = await listBackupRuns({ databaseId: "db_1" });
    assert.equal(runs.length, 1);
    assert.equal(runs[0]!.status, "failed");
    assert.equal(runs[0]!.backupId, null);
    assert.equal(runs[0]!.databaseId, "db_1");
  });
});

test("a backup cut off when its server drops says the server is offline, and runs again", async (t) => {
  let cut = true;
  __setAgentConnectorForTest(async () => {
    const conn = {
      hello: async () => ({
        capabilities: [BACKUP_CAPABILITY, BACKUP_ENCRYPT_S3_CAPABILITY],
      }),
      async *backup() {
        if (cut)
          throw new AgentUnreachableError(
            "14 UNAVAILABLE: Connection dropped",
            GrpcStatus.UNAVAILABLE,
          );
        yield { result: { ok: true, error: "", sizeBytes: 3, sha256: "" } };
      },
      close: () => {},
    };
    return conn as unknown as AgentConnection;
  });
  t.after(() => __setAgentConnectorForTest());
  await asUser1(async () => {
    await runDatabaseBackup("db_1", "s3_1").catch(() => {});
    const [failed] = await listBackupRuns({ databaseId: "db_1" });
    assert.equal(failed!.status, "failed");
    assert.equal(
      failed!.error,
      `This server is offline. ${LINK_OFFLINE_MESSAGE}`,
    );

    cut = false;
    await runDatabaseBackup("db_1", "s3_1");
    const runs = await listBackupRuns({ databaseId: "db_1" });
    assert.deepEqual(runs.map((r) => r.status).sort(), ["failed", "success"]);
  });
});
