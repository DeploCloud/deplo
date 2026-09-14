import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { runWithIdentity } from "../auth/request-context";
import { seedIdentity, TEAM_A, USER_1 } from "./identity-test-helpers";
import { seedServer, SERVER_1 } from "./app-graph-test-helpers";
import {
  seedCleanupRun,
  TRUNCATE_CLEANUP,
} from "./docker-cleanup-test-helpers";
import { publishCleanupRunsChanged } from "../graphql/pubsub";
import { cleanupRunsStream } from "../graphql/types/cleanup";
import { __settleCleanupSweeps, runCleanupNow } from "./docker-cleanup/sweep";

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
  await pg.exec(`${TRUNCATE_CLEANUP}
    truncate table activities, servers, users, teams restart identity cascade;`);
  await seedIdentity(db, {
    users: [{ id: USER_1, teamId: TEAM_A, role: "owner" }],
  });
  await seedServer(db);
});

test("cleanupRunsStream yields the initial snapshot + multiple change pings (cookie-free)", async () => {
  await seedCleanupRun(db, {
    id: "dcr_1",
    startedAt: "2026-01-01T00:00:00.000Z",
  });

  // No runWithIdentity on purpose: the gate is on the subscription field, not the generator.
  const gen = cleanupRunsStream();

  const first = await gen.next();
  assert.equal(first.done, false);
  assert.deepEqual(
    first.value.map((r) => r.id),
    ["dcr_1"],
  );

  const p1 = gen.next();
  await seedCleanupRun(db, {
    id: "dcr_2",
    startedAt: "2026-01-02T00:00:00.000Z",
  });
  publishCleanupRunsChanged();
  const second = await p1;
  assert.equal(second.done, false);
  assert.deepEqual(
    second.value.map((r) => r.id),
    ["dcr_2", "dcr_1"],
  );

  const p2 = gen.next();
  await seedCleanupRun(db, {
    id: "dcr_3",
    startedAt: "2026-01-03T00:00:00.000Z",
  });
  publishCleanupRunsChanged();
  const third = await p2;
  assert.equal(third.done, false);
  assert.deepEqual(
    third.value.map((r) => r.id),
    ["dcr_3", "dcr_2", "dcr_1"],
  );

  await gen.return(undefined as never);
});

test("a detached sweep's outcome is in the stream, with no caller left to catch it", async () => {
  const started = await runWithIdentity(
    { userId: USER_1, teamId: TEAM_A },
    () => runCleanupNow(SERVER_1),
  );
  assert.equal(started.status, "running");

  await __settleCleanupSweeps();

  const gen = cleanupRunsStream();
  const snapshot = await gen.next();
  await gen.return(undefined as never);

  assert.equal(snapshot.value.length, 1);
  const run = snapshot.value[0]!;
  assert.equal(run.id, started.id);
  assert.equal(run.status, "failed");
  assert.match(run.error ?? "", /not provisioned yet/);
});
