import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PGlite } from "@electric-sql/pglite";

process.env.DEPLO_DATA_DIR = mkdtempSync(join(tmpdir(), "deplo-sse-"));

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { seedIdentity, TEAM_A, USER_1 } from "./identity-test-helpers";
import {
  seedServer,
  seedApp,
  TRUNCATE_PROJECT_GRAPH,
} from "./app-graph-test-helpers";
import { publishAppChanged } from "../graphql/pubsub";
import { appStatusStream } from "../graphql/types/app";

/**
 * Step 4 SSE generator test (relational-store PLAN §6 "SSE generators must stay
 * cookie-free"): the appStatus subscription generator must paint the initial
 * snapshot AND forward >1 change ping WITHOUT ever calling a cookie-reading
 * helper — `cookies()` is not callable across the async-iteration ticks of a
 * long-lived SSE response, so a cookie read would crash the stream after the
 * first ping. The generator is driven here with an explicit teamId and NO request
 * scope (no `runWithIdentity`), proving it is cookie-free.
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
  await pg.exec(`${TRUNCATE_PROJECT_GRAPH}
    truncate table users, teams restart identity cascade;`);
  await seedIdentity(db, { users: [{ id: USER_1, teamId: TEAM_A, role: "owner" }] });
  await seedServer(db);
});

test("appStatusStream yields the initial snapshot + multiple change pings (cookie-free)", async () => {
  await seedApp(db, { id: "prj_1", slug: "alpha", teamId: TEAM_A, status: "active" });

  // NO runWithIdentity — there is no request scope. If the generator read a
  // cookie it would throw here.
  const gen = appStatusStream("alpha", TEAM_A);

  // Initial snapshot.
  const first = await gen.next();
  assert.equal(first.done, false);
  assert.equal(first.value.id, "prj_1");
  assert.equal(first.value.slug, "alpha");

  // Ping 1: a change → the generator reloads + yields a fresh snapshot.
  const p1 = gen.next();
  publishAppChanged("prj_1");
  const second = await p1;
  assert.equal(second.done, false);
  assert.equal(second.value.id, "prj_1");

  // Ping 2: a SECOND change across another iteration tick — this is the case the
  // cookie-free guarantee protects (the old crash point).
  const p2 = gen.next();
  publishAppChanged("prj_1");
  const third = await p2;
  assert.equal(third.done, false);
  assert.equal(third.value.id, "prj_1");

  await gen.return(undefined as never);
});

test("appStatusStream rejects an unknown slug / wrong team", async () => {
  await seedApp(db, { id: "prj_1", slug: "alpha", teamId: TEAM_A, status: "active" });
  await assert.rejects(() => appStatusStream("nope", TEAM_A).next(), /App not found/);
  await assert.rejects(() => appStatusStream("alpha", "team_other").next(), /App not found/);
  await assert.rejects(() => appStatusStream("alpha", null).next(), /App not found/);
});

test("appStatusStream ends when the project is deleted mid-stream", async () => {
  await seedApp(db, { id: "prj_1", slug: "alpha", teamId: TEAM_A, status: "active" });
  const gen = appStatusStream("alpha", TEAM_A);
  await gen.next(); // initial
  // Delete the project, then ping — the reload returns null → the generator ends.
  const p = gen.next();
  await pg.exec(`delete from apps where id = 'prj_1';`);
  publishAppChanged("prj_1");
  const next = await p;
  assert.equal(next.done, true, "generator ends when the project vanishes");
});
