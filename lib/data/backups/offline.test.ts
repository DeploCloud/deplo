import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { PGlite } from "@electric-sql/pglite";

import { makeTestDb, type TestDb } from "../../db/test-harness";
import { __setTestDb, __resetTestDb } from "../../db/client";
import { AgentOfflineError } from "../../infra/agent-client/errors";
import { seedServerRow } from "../infra-test-helpers";
import { backupServerOffline } from "./offline";

let db: TestDb;
let pg: PGlite;

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
  await seedServerRow(db, { id: "srv_1", name: "eu-1" });
  await seedServerRow(db, { id: "srv_2", name: "eu-2" });
});

after(async () => {
  __resetTestDb();
  await pg.close();
});

// eu, 24 Nov 2026: "Backup of memos failed: This server is offline", when eu-1, where it was kept, was powered off.
test("a failed backup names the server that is offline and whether it is the source or the destination", async () => {
  assert.match(
    (await backupServerOffline(new AgentOfflineError("srv_1"), "srv_2"))!,
    /^eu-1, this backup's destination, is offline\./,
  );
  assert.match(
    (await backupServerOffline(new AgentOfflineError("srv_2"), "srv_2"))!,
    /^eu-2, this backup's source, is offline\./,
  );
  assert.equal(await backupServerOffline(new Error("boom"), "srv_2"), null);
});
