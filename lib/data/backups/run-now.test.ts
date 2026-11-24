import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../../db/test-harness";
import { __setTestDb, __resetTestDb } from "../../db/client";
import {
  backupRuns,
  backups as backupsTable,
} from "../../db/schema/control-plane/backups";
import { databases } from "../../db/schema/control-plane/databases";
import { seedBackup } from "../backup-test-helpers";
import { asUser1, seedBase } from "./backups-test-helpers";
import { runAppBackup, runBackup, runDatabaseBackup } from "./run-now";
import { activities } from "../../db/schema/control-plane/activity";
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

test("a run records how long the agent held the App, and nothing when it held none", async (t) => {
  let heldMs = 2140;
  __setAgentConnectorForTest(async () => {
    const conn = {
      hello: async () => ({
        capabilities: [BACKUP_CAPABILITY, BACKUP_ENCRYPT_S3_CAPABILITY],
      }),
      async *backup() {
        yield {
          result: { ok: true, error: "", sizeBytes: 3, sha256: "", heldMs },
        };
      },
      close: () => {},
    };
    return conn as unknown as AgentConnection;
  });
  t.after(() => __setAgentConnectorForTest());
  await asUser1(async () => {
    await runDatabaseBackup("db_1", "s3_1");
    heldMs = 0;
    await runDatabaseBackup("db_1", "s3_1");
    const runs = await listBackupRuns({ databaseId: "db_1" });
    assert.deepEqual(runs.map((r) => r.heldMs).sort(), [2140, null]);
  });
});

// eu, 24 Nov 2026: nothing said that a backup between two members went through Deplo.
test("a run records whether it went server to server or through Deplo", async (t) => {
  __setAgentConnectorForTest(async () => {
    const conn = {
      hello: async () => ({
        capabilities: [BACKUP_CAPABILITY, BACKUP_ENCRYPT_S3_CAPABILITY],
      }),
      async *backup() {
        yield {
          result: {
            ok: true,
            error: "",
            sizeBytes: 3,
            sha256: "",
            path: "direct",
          },
        };
      },
      close: () => {},
    };
    return conn as unknown as AgentConnection;
  });
  t.after(() => __setAgentConnectorForTest());
  await asUser1(async () => {
    await runDatabaseBackup("db_1", "s3_1");
    const runs = await listBackupRuns({ databaseId: "db_1" });
    assert.ok(runs.some((r) => r.path === "direct"));
  });
});

test("a backup that paused the App for its whole copy says why in Activity", async (t) => {
  __setAgentConnectorForTest(async () => {
    const conn = {
      hello: async () => ({
        capabilities: [BACKUP_CAPABILITY, BACKUP_ENCRYPT_S3_CAPABILITY],
      }),
      async *backup() {
        yield {
          result: {
            ok: true,
            error: "",
            sizeBytes: 3,
            sha256: "",
            heldMs: 12_300,
            heldWhy:
              "the server has 0.3 GB free, too little to copy 2.0 GB of data on its own disk first",
          },
        };
      },
      close: () => {},
    };
    return conn as unknown as AgentConnection;
  });
  t.after(() => __setAgentConnectorForTest());
  await asUser1(() => runDatabaseBackup("db_1", "s3_1"));
  const said = (await db.select().from(activities)).map((a) => a.message);
  assert.ok(
    said.some((m) =>
      /^Backed up .*\. It was paused for the whole copy \(12\.3 s\): the server has 0\.3 GB free, too little to copy 2\.0 GB of data on its own disk first$/.test(
        m,
      ),
    ),
    said.join("\n"),
  );
});

test("a backup that fails before it reaches the server still names what it was backing up", async (t) => {
  __setAgentConnectorForTest(async () => {
    throw new AgentUnreachableError("offline", GrpcStatus.UNAVAILABLE);
  });
  t.after(() => __setAgentConnectorForTest());
  await pg.exec("truncate table activities");
  await asUser1(async () => {
    await runAppBackup("prj_1", "s3_1").catch(() => {});
    await runDatabaseBackup("db_1", "s3_1").catch(() => {});
  });
  const said = (await db.select({ m: activities.message }).from(activities))
    .map((a) => a.m.replace(/:.*/, ""))
    .sort();
  assert.deepEqual(said, [
    "Backup of database main failed",
    "Backup of prj_1 failed",
  ]);
});

// eu, 24 Nov 2026: a copy saved 3 s after its App was deleted stayed as a backup. One that lands after its target
// went is removed from the destination, never listed, and Activity says nothing of it.
test("a backup that lands after its database was deleted is removed, not kept", async (t) => {
  const deleted: string[] = [];
  __setAgentConnectorForTest(async () => {
    const conn = {
      hello: async () => ({
        capabilities: [BACKUP_CAPABILITY, BACKUP_ENCRYPT_S3_CAPABILITY],
      }),
      async *backup(req: { s3?: { objectKey?: string } }) {
        await db.delete(databases).where(eq(databases.id, "db_1"));
        yield {
          result: {
            ok: true,
            error: "",
            sizeBytes: 3,
            sha256: "",
            objectKey: req.s3?.objectKey ?? "",
          },
        };
      },
      s3Delete: async (target: { objectKey: string }) => {
        deleted.push(target.objectKey);
        return { ok: true, error: "", deleted: 1 };
      },
      close: () => {},
    };
    return conn as unknown as AgentConnection;
  });
  t.after(() => __setAgentConnectorForTest());
  await asUser1(async () => {
    await assert.rejects(() => runDatabaseBackup("db_1", "s3_1"), /deleted/);
  });
  const runs = await db.select().from(backupRuns);
  assert.equal(runs.length, 1);
  assert.notEqual(runs[0]!.status, "success");
  assert.deepEqual(deleted, [runs[0]!.objectKey]);
  const lines = (await db.select().from(activities)).map((a) => a.message);
  assert.ok(
    !lines.some((m) => /Backed up|Backup of .* failed/.test(m)),
    lines.join("\n"),
  );
});
