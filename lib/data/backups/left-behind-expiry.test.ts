import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../../db/test-harness";
import { __setTestDb, __resetTestDb } from "../../db/client";
import { backupRuns as backupRunsTable } from "../../db/schema/control-plane/backups";
import { activities } from "../../db/schema/control-plane/activity";
import { servers as serversTable } from "../../db/schema/control-plane/servers";
import { __setAgentConnectorForTest } from "../../infra/agent-client/connect";
import type { AgentConnection } from "../../infra/agent-client/connection";
import { BACKUP_CAPABILITY } from "../../infra/agent-client/hello-capabilities";
import { SERVER_1 } from "../app-graph-test-helpers";
import { seedRun } from "../backup-test-helpers";
import { seedBase } from "./backups-test-helpers";
import { expireLeftBehindRuns } from "./left-behind-expiry";

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
beforeEach(async () => {
  await seedBase(db, pg);
  await db
    .update(serversTable)
    .set({ agentCertFingerprint: "1".repeat(64) })
    .where(eq(serversTable.id, SERVER_1));
});

const NOW = Date.parse("2026-11-27T12:00:00Z");

async function leftRun(id: string, leftAt: string) {
  await seedRun(db, {
    id,
    destinationId: "s3_1",
    databaseId: "db_1",
    objectKey: `deplo/team_a/database/db_1/left-${id}.gz`,
    sizeBytes: 2048,
    startedAt: leftAt,
  });
  await db
    .update(backupRunsTable)
    .set({ leftAt, leftOnServerId: SERVER_1 })
    .where(eq(backupRunsTable.id, id));
}

// c50: 56 "Left on" backups, about 1 GB on the members' disks, the oldest from 22 Nov, and nothing removed them.
test("a returning member's left-behind backups expire like set-aside copies: the newest stays, older than 7 days go", async (t) => {
  const deleted: string[] = [];
  __setAgentConnectorForTest(async () => {
    const conn = {
      hello: async () => ({ capabilities: [BACKUP_CAPABILITY] }),
      s3Delete: async (target: { objectKey: string }) => {
        deleted.push(target.objectKey);
        return { ok: true, error: "", deleted: 1 };
      },
      close: () => {},
    };
    return conn as unknown as AgentConnection;
  });
  t.after(() => __setAgentConnectorForTest());
  await leftRun("r_new", "2026-11-26T00:00:00.000Z");
  await leftRun("r_mid", "2026-11-24T00:00:00.000Z");
  await seedRun(db, {
    id: "r_own",
    destinationId: "s3_1",
    databaseId: "db_1",
    startedAt: "2026-11-01T00:00:00.000Z",
  });
  await leftRun("r_old", "2026-11-01T00:00:00.000Z");

  await expireLeftBehindRuns(NOW);

  assert.deepEqual(deleted, ["deplo/team_a/database/db_1/left-r_old.gz"]);
  const left = (
    await db.select({ id: backupRunsTable.id }).from(backupRunsTable)
  )
    .map((r) => r.id)
    .sort();
  assert.deepEqual(left, ["r_mid", "r_new", "r_own"]);
  const said = (await db.select().from(activities)).map((a) => a.message);
  assert.ok(
    said.includes(
      `Removed the backup of main that ${SERVER_1} left on 2026-11-01 00:00 UTC (2 KiB): it was older than 7 days, and a newer one is kept.`,
    ),
    said.join(" | "),
  );
});
