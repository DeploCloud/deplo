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
  await seedIdentity(db, {
    users: [{ id: USER_1, teamId: TEAM_A, role: "owner" }],
  });
  await seedServer(db);
});

test("databaseStatusStream yields the initial snapshot + multiple change pings (cookie-free)", async () => {
  await seedDatabase(db, { id: "db_1", name: "main", status: "provisioning" });

  const gen = databaseStatusStream("db_1", TEAM_A, USER_1);

  const first = await gen.next();
  assert.equal(first.done, false);
  assert.equal(first.value.id, "db_1");
  assert.equal(first.value.status, "provisioning");
  assert.equal("connectionStringEnc" in first.value, false);
  assert.ok(first.value.connectionStringMasked.includes("••••"));

  const p1 = gen.next();
  await pg.exec(`update databases set status = 'running' where id = 'db_1';`);
  publishDatabaseChanged("db_1");
  const second = await p1;
  assert.equal(second.done, false);
  assert.equal(second.value.status, "running");

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
    () => databaseStatusStream("db_nope", TEAM_A, USER_1).next(),
    /Database not found/,
  );
  await assert.rejects(
    () => databaseStatusStream("db_1", "team_other", USER_1).next(),
    /Database not found/,
  );
  await assert.rejects(
    () => databaseStatusStream("db_1", null, USER_1).next(),
    /Database not found/,
  );
  // The gate this replaced answered "unrestricted" when it could not resolve a user.
  await assert.rejects(
    () => databaseStatusStream("db_1", TEAM_A, null).next(),
    /Database not found/,
  );
});

test("databaseStatusStream ends when the database is deleted mid-stream", async () => {
  await seedDatabase(db, { id: "db_1", name: "main" });
  const gen = databaseStatusStream("db_1", TEAM_A, USER_1);
  await gen.next();
  const p = gen.next();
  await pg.exec(`delete from databases where id = 'db_1';`);
  publishDatabaseChanged("db_1");
  const next = await p;
  assert.equal(next.done, true, "generator ends when the database vanishes");
});
