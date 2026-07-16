import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { seedIdentity, TEAM_A, USER_1 } from "./identity-test-helpers";
import { seedServer } from "./app-graph-test-helpers";
import { seedDatabase, TRUNCATE_BACKUPS } from "./backup-test-helpers";
import { publishDatabaseChanged } from "../graphql/pubsub";
import { databaseStatusStream } from "../graphql/types/database";

/**
 * SSE generator test for the databaseStatus subscription — the database twin of
 * app-sse.test.ts (same contract): the generator must paint the initial
 * snapshot AND forward >1 change ping WITHOUT ever calling a cookie-reading
 * helper (`cookies()` is not callable across the async-iteration ticks of a
 * long-lived SSE response). Driven with an explicit teamId and NO request scope
 * (no `runWithIdentity`), proving it is cookie-free — and it must yield the
 * MASKED DTO, never the encrypted connection string.
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
  await pg.exec(`${TRUNCATE_BACKUPS}
    truncate table users, teams restart identity cascade;`);
  await seedIdentity(db, { users: [{ id: USER_1, teamId: TEAM_A, role: "owner" }] });
  await seedServer(db);
});

test("databaseStatusStream yields the initial snapshot + multiple change pings (cookie-free)", async () => {
  await seedDatabase(db, { id: "db_1", name: "main", status: "provisioning" });

  const gen = databaseStatusStream("db_1", TEAM_A);

  // Initial snapshot — masked DTO, no secret projected.
  const first = await gen.next();
  assert.equal(first.done, false);
  assert.equal(first.value.id, "db_1");
  assert.equal(first.value.status, "provisioning");
  assert.equal("connectionStringEnc" in first.value, false);
  assert.ok(first.value.connectionStringMasked.includes("••••"));

  // Ping 1: the provision flips the status → the generator reloads fresh state.
  const p1 = gen.next();
  await pg.exec(`update databases set status = 'running' where id = 'db_1';`);
  publishDatabaseChanged("db_1");
  const second = await p1;
  assert.equal(second.done, false);
  assert.equal(second.value.status, "running");

  // Ping 2: a SECOND change across another iteration tick (the old cookie
  // crash point in the app twin).
  const p2 = gen.next();
  await pg.exec(`update databases set status = 'stopped' where id = 'db_1';`);
  publishDatabaseChanged("db_1");
  const third = await p2;
  assert.equal(third.done, false);
  assert.equal(third.value.status, "stopped");

  await gen.return(undefined as never);
});

test("databaseStatusStream rejects an unknown id / wrong team / no team", async () => {
  await seedDatabase(db, { id: "db_1", name: "main" });
  await assert.rejects(
    () => databaseStatusStream("db_nope", TEAM_A).next(),
    /Database not found/,
  );
  await assert.rejects(
    () => databaseStatusStream("db_1", "team_other").next(),
    /Database not found/,
  );
  await assert.rejects(
    () => databaseStatusStream("db_1", null).next(),
    /Database not found/,
  );
});

test("databaseStatusStream ends when the database is deleted mid-stream", async () => {
  await seedDatabase(db, { id: "db_1", name: "main" });
  const gen = databaseStatusStream("db_1", TEAM_A);
  await gen.next(); // initial
  const p = gen.next();
  await pg.exec(`delete from databases where id = 'db_1';`);
  publishDatabaseChanged("db_1");
  const next = await p;
  assert.equal(next.done, true, "generator ends when the database vanishes");
});
