import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";

import { makeTestDb, type TestDb } from "../../db/test-harness";
import { __setTestDb, __resetTestDb } from "../../db/client";
import { __setAgentConnectorForTest } from "../../infra/agent-client/connect";
import type { AgentConnection } from "../../infra/agent-client/connection";
import { runWithIdentity } from "../../auth/request-context";
import { TEAM_A } from "../identity-test-helpers";
import { seedRun } from "../backup-test-helpers";
import { deleteApp } from "../apps/delete";
import { deleteDatabase } from "../databases/lifecycle";
import { seedBase, USER_DELETER } from "./backups-test-helpers";
import { deleteAllBackupArtifacts } from "./artifact-delete";

let db: TestDb;
let pg: PGlite;
let deleted: string[] = [];

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
  // Every agent call succeeds; the stored files it is asked to delete are recorded.
  __setAgentConnectorForTest(
    async () =>
      new Proxy(
        {},
        {
          get(_t, prop: string) {
            if (prop === "close") return () => {};
            if (prop === "then") return undefined;
            return async (...args: unknown[]) => {
              if (prop === "s3Delete" || prop === "storeDelete") {
                const t = args[0] as { objectKey?: string; key?: string };
                deleted.push(t.objectKey ?? t.key ?? "");
                return { ok: true, error: "", deleted: 1 };
              }
              if (prop === "hello")
                return {
                  ok: true,
                  capabilities: ["backup", "backup-store", "backup-encrypt-s3"],
                };
              if (prop === "listInstances") return [];
              return { ok: true, error: "" };
            };
          },
        },
      ) as unknown as AgentConnection,
  );
});

after(async () => {
  __setAgentConnectorForTest();
  __resetTestDb();
  await pg.close();
});

beforeEach(async () => {
  await seedBase(db, pg);
  deleted = [];
  await seedRun(db, {
    id: "r_app",
    destinationId: "s3_1",
    targetKind: "app",
    appId: "prj_1",
  });
  await seedRun(db, { id: "r_db", destinationId: "s3_1", databaseId: "db_1" });
});

const asDeleter = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: USER_DELETER, teamId: TEAM_A }, fn);
const runIds = async () =>
  (
    await pg.query<{ id: string }>(`select id from backup_runs order by id`)
  ).rows.map((r) => r.id);

test("deleting an app takes its backups with it, without delete_backups", async () => {
  await asDeleter(() => deleteApp("prj_1"));
  assert.deepEqual(deleted, ["deplo/team_a/app/t/r_app.gz"]);
  assert.deepEqual(await runIds(), ["r_db"]);
});

test("deleting a database takes its backups with it, without delete_backups", async () => {
  await asDeleter(() => deleteDatabase("db_1"));
  assert.deepEqual(deleted, ["deplo/team_a/database/t/r_db.gz"]);
  assert.deepEqual(await runIds(), ["r_app"]);
});

test("the same member cannot wipe a LIVE target's backups", async () => {
  await asDeleter(async () => {
    for (const target of [
      { kind: "app", targetId: "prj_1" },
      { kind: "database", targetId: "db_1" },
    ] as const)
      await assert.rejects(
        () => deleteAllBackupArtifacts(target),
        /permission to delete backups/i,
      );
  });
  assert.deepEqual(deleted, []);
  assert.deepEqual(await runIds(), ["r_app", "r_db"]);
});
