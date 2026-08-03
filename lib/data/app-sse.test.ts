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
import { runWithIdentity } from "../auth/request-context";
import { projects as projectsTable } from "../db/schema/control-plane";
import { ALL_CAPABILITIES } from "../types";
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
    truncate table projects, users, teams restart identity cascade;`);
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

/**
 * The identity seam for subscriptions.
 *
 * An async generator body does NOT inherit the async context of whoever created
 * it — it runs in the context of whoever calls `next()`, which for a long-lived
 * SSE response is the event loop, long after the request handler returned. So
 * the yoga plugin re-applies `runWithIdentity` around every tick; this asserts
 * the shape it relies on, and that a project scope survives into tick 2 (where
 * an unscoped tick would have streamed an app the token cannot otherwise see).
 */
test("a project scope holds on EVERY tick of the stream, not just the first", async () => {
  await db.insert(projectsTable).values({
    id: "prc_out",
    teamId: TEAM_A,
    name: "Out",
    slug: "out",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  await seedApp(db, {
    id: "prj_1",
    slug: "alpha",
    teamId: TEAM_A,
    status: "active",
    projectId: "prc_out",
  });

  const token = {
    id: "tok_test",
    capabilities: [...ALL_CAPABILITIES],
    // Scoped to a project the app is NOT in.
    scope: {
      teamIds: [TEAM_A],
      wholeTeamIds: [],
      projectIds: ["prc_in"],
      folderIds: [],
      appIds: [],
      appProjectIds: [],
    },
    instanceAdmin: false,
  };
  const asScoped = <T>(fn: () => T) =>
    runWithIdentity({ userId: USER_1, teamId: TEAM_A, token }, fn);

  // Tick 0: the initial snapshot is refused, exactly like an unknown slug.
  const gen = asScoped(() => appStatusStream("alpha", TEAM_A));
  await assert.rejects(() => asScoped(() => gen.next()), /App not found/);

  // And with the scope covering the app, the stream survives past tick 1 — the
  // regression this wrapper exists for.
  const ok = {
    id: "tok_test",
    capabilities: [...ALL_CAPABILITIES],
    scope: {
      teamIds: [TEAM_A],
      wholeTeamIds: [],
      projectIds: ["prc_out"],
      folderIds: [],
      appIds: [],
      appProjectIds: [],
    },
    instanceAdmin: false,
  };
  const asOk = <T>(fn: () => T) =>
    runWithIdentity({ userId: USER_1, teamId: TEAM_A, token: ok }, fn);
  const gen2 = asOk(() => appStatusStream("alpha", TEAM_A));
  assert.equal((await asOk(() => gen2.next())).value.id, "prj_1");
  const pending = asOk(() => gen2.next());
  publishAppChanged("prj_1");
  assert.equal((await pending).value.id, "prj_1");
  await asOk(() => gen2.return(undefined as never));
});
