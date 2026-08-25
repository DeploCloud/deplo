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
import { __settleCleanupSweeps, runCleanupNow } from "./docker-cleanup";

/**
 * The Docker-cleanup history stream - the sibling of `app-sse.test.ts`, and the
 * thing that makes "Clean up now" instant honest: the click is answered before the
 * host is touched, so the run row it hands back has to keep moving on its own.
 */

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

  // NO runWithIdentity - there is no request scope. The gate lives on the subscription
  // field (instance-admin, evaluated when the stream is opened); if the generator read
  // a cookie or re-gated, it would throw here.
  const gen = cleanupRunsStream();

  const first = await gen.next();
  assert.equal(first.done, false);
  assert.deepEqual(
    first.value.map((r) => r.id),
    ["dcr_1"],
  );

  // Ping 1: the history changed → a fresh snapshot, newest first.
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

  // Ping 2: a SECOND change across another iteration tick - the case the cookie-free
  // guarantee protects.
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
  // The whole point of the background sweep: the admin who clicked may be gone. The
  // run starts inside a request…
  const started = await runWithIdentity(
    { userId: USER_1, teamId: TEAM_A },
    () => runCleanupNow(SERVER_1),
  );
  assert.equal(started.status, "running");

  // …and settles outside of one (the seeded server has no agent, so it fails).
  await __settleCleanupSweeps();

  // A page opening the stream now - a fresh subscriber, or one whose SSE connection
  // dropped and self-healed - is handed the settled truth, not the `running` row it
  // last saw.
  const gen = cleanupRunsStream();
  const snapshot = await gen.next();
  await gen.return(undefined as never);

  assert.equal(snapshot.value.length, 1);
  const run = snapshot.value[0]!;
  assert.equal(run.id, started.id);
  assert.equal(run.status, "failed");
  assert.match(run.error ?? "", /not provisioned yet/);
});
