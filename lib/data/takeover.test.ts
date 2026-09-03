import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { PGlite } from "@electric-sql/pglite";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { runWithIdentity } from "../auth/request-context";
import {
  seedIdentity,
  TRUNCATE_IDENTITY,
  TEAM_A,
} from "./identity-test-helpers";
import {
  __resetMigrationFetchForTest,
  __setMigrationFetchForTest,
} from "../migration/transport";
import {
  cancelTakeover,
  ensureTakeoverFromEnv,
  markTakeoverProgress,
  noteBrowserReached,
  requestTakeover,
  takeoverBlocksDashboard,
  takeoverStatus,
} from "./takeover";

/**
 * The takeover's state, which is the handshake between a browser and an installer
 * that cannot see each other. Getting it wrong means a machine whose ports belong
 * to nobody, so nothing may move backwards.
 */

let db: TestDb;
let pg: PGlite;

const ADMIN = "admin1";
const MEMBER = "member2";

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
});

after(async () => {
  __resetTestDb();
  delete process.env.DEPLO_TAKEOVER;
  await pg.close();
});

beforeEach(async () => {
  await pg.exec(TRUNCATE_IDENTITY);
  await db.execute("delete from instance_settings;");
  await db.execute("delete from migration_runs;");
  await seedIdentity(db, {
    users: [
      { id: ADMIN, teamId: TEAM_A, role: "owner", isInstanceAdmin: true },
      { id: MEMBER, teamId: TEAM_A, role: "member", isInstanceAdmin: false },
    ],
  });
  delete process.env.DEPLO_TAKEOVER;
});

const asUser = <T>(userId: string, fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId, teamId: TEAM_A }, fn);

/** Every read is `cache`d per request, so each assertion needs its own context. */
const read = () =>
  runWithIdentity({ userId: ADMIN, teamId: TEAM_A }, takeoverStatus);

/** A finished run, which is what taking the ports is allowed to follow. */
async function seedFinishedRun(
  id: string,
  status = "done",
  keepSources = false,
): Promise<void> {
  await db.execute(
    `insert into migration_runs
       (id, team_id, source_url, platform, actor, status, created, skipped, failed,
        manual, started_at, total_steps, done_steps, phase, keep_sources)
     values ('${id}', '${TEAM_A}', 'http://panel.test:3000', 'dokploy', 'Tester',
             '${status}', 1, 0, 0, 0, now(), 1, 1, 'done', ${keepSources});`,
  );
}

async function seedPending(platform = "dokploy"): Promise<void> {
  process.env.DEPLO_TAKEOVER = platform;
  await asUser(ADMIN, ensureTakeoverFromEnv);
}

test("an ordinary install is not a takeover", async () => {
  await asUser(ADMIN, ensureTakeoverFromEnv);
  assert.equal(await read(), null);
  assert.equal(
    await runWithIdentity(
      { userId: ADMIN, teamId: TEAM_A },
      takeoverBlocksDashboard,
    ),
    false,
  );
});

test("a platform the installer does not name is ignored, not stored", async () => {
  process.env.DEPLO_TAKEOVER = "kubernetes";
  await asUser(ADMIN, ensureTakeoverFromEnv);
  assert.equal(await read(), null);
});

test("the installer's platform becomes a pending takeover, and it blocks", async () => {
  await seedPending("coolify");
  const t = await read();
  assert.equal(t?.platform, "coolify");
  assert.equal(t?.state, "pending");
  assert.equal(t?.seenExternalRequest, false);
  assert.equal(
    await runWithIdentity(
      { userId: ADMIN, teamId: TEAM_A },
      takeoverBlocksDashboard,
    ),
    true,
  );
});

test("a restart mid-run does not send the operator back to the beginning", async () => {
  await seedPending();
  await seedFinishedRun("run_1");
  await asUser(ADMIN, () => requestTakeover("run_1"));
  // Boot again with the same env var still set, as every restart does.
  await asUser(ADMIN, ensureTakeoverFromEnv);
  assert.equal((await read())?.state, "ready");
});

test("the ladder only ever goes forward", async () => {
  await seedPending();
  await seedFinishedRun("run_1");
  await asUser(ADMIN, () => requestTakeover("run_1"));
  assert.equal((await read())?.runId, "run_1");

  // `done` is the installer's to report, and only from `ready`.
  await asUser(ADMIN, () => markTakeoverProgress("done"));
  assert.equal((await read())?.state, "done");

  await seedFinishedRun("run_2");
  await assert.rejects(
    () => asUser(ADMIN, () => requestTakeover("run_2")),
    /cannot move to "ready"/,
    "a finished takeover must not be restartable",
  );
  await assert.rejects(
    () => asUser(ADMIN, () => cancelTakeover()),
    /already Deplo's/,
    "the ports have moved; there is nothing to hand back",
  );

  // The removal is the same confirmed action, so the installer reports it too.
  await asUser(ADMIN, () => markTakeoverProgress("removing"));
  await asUser(ADMIN, () => markTakeoverProgress("removed"));
  assert.equal((await read())?.state, "removed");
  await assert.rejects(
    () => asUser(ADMIN, () => markTakeoverProgress("removing")),
    /cannot move to "removing"/,
  );
});

test("the dashboard opens only once the old platform is gone", async () => {
  const blocks = () =>
    runWithIdentity({ userId: ADMIN, teamId: TEAM_A }, takeoverBlocksDashboard);
  await seedPending();
  await seedFinishedRun("run_1");
  await asUser(ADMIN, () => requestTakeover("run_1"));
  await asUser(ADMIN, () => markTakeoverProgress("done"));
  assert.equal(
    await blocks(),
    true,
    "the ports have moved but the other platform is still on the disk",
  );
  await asUser(ADMIN, () => markTakeoverProgress("removing"));
  assert.equal(await blocks(), true);
  await asUser(ADMIN, () => markTakeoverProgress("removed"));
  assert.equal(await blocks(), false, "now it is Deplo and nothing else");
});

test("only an instance admin decides any of it", async () => {
  await seedPending();
  await seedFinishedRun("run_1");
  await assert.rejects(() => asUser(MEMBER, () => requestTakeover("run_1")));
  await assert.rejects(() => asUser(MEMBER, () => cancelTakeover()));
  assert.equal((await read())?.state, "pending");
});

test("a browser reaching the panel is stamped once", async () => {
  await seedPending();
  await asUser(ADMIN, noteBrowserReached);
  const first = await read();
  assert.equal(first?.seenExternalRequest, true);

  // Stamped once: the installer only asks whether it EVER happened.
  await asUser(ADMIN, noteBrowserReached);
  assert.equal((await read())?.seenExternalRequest, true);
});

test("nothing is stamped when this install is not a takeover", async () => {
  await asUser(ADMIN, noteBrowserReached);
  assert.equal(await read(), null);
});

test("backing out with no run to undo still ends the takeover", async () => {
  await seedPending();
  const res = await asUser(ADMIN, () => cancelTakeover());
  assert.deepEqual(res, { restarted: 0, left: [] });
  assert.equal((await read())?.state, "cancelled");
});

/** A run that stopped one service over there, the way the data phase records it. */
async function seedStoppedTarget(): Promise<void> {
  await db.execute(
    `insert into migration_runs
       (id, team_id, source_url, platform, actor, status, created, skipped, failed,
        manual, started_at, total_steps, done_steps, phase)
     values ('run_t1', '${TEAM_A}', 'http://panel.test:3000', 'dokploy', 'Tester',
             'done', 1, 0, 0, 0, now(), 1, 1, 'done');`,
  );
  await db.execute(
    `insert into migration_run_targets
       (id, run_id, project_id, project_name, service_id, state, stopped_kind, stopped_at)
     values ('tgt_1', 'run_t1', 'p1', 'netcase', 'svc_1', 'done', 'compose', now());`,
  );
}

test("backing out before the ports were even asked for still restarts what was stopped", async (t) => {
  t.after(__resetMigrationFetchForTest);
  await seedPending();
  await seedStoppedTarget();

  // The takeover's own runId is written by requestTakeover, which a cancel at
  // this point has not reached - so the undo has to find the stop itself.
  assert.equal((await read())?.runId, null);

  const calls: string[] = [];
  __setMigrationFetchForTest(async (url) => {
    calls.push(String(url));
    return new Response("true", { status: 200 });
  });

  const res = await asUser(ADMIN, () => cancelTakeover("the-token"));
  assert.deepEqual(res, { restarted: 1, left: [] });
  assert.deepEqual(calls, ["http://panel.test:3000/api/compose.start"]);
  assert.equal((await read())?.state, "cancelled");
});

test("a stop that will not undo is named, not swallowed", async (t) => {
  t.after(__resetMigrationFetchForTest);
  await seedPending();
  await seedStoppedTarget();
  __setMigrationFetchForTest(async () => new Response("nope", { status: 500 }));

  const res = await asUser(ADMIN, () => cancelTakeover("the-token"));
  assert.equal(res.restarted, 0);
  assert.equal(res.left.length, 1);
  assert.match(res.left[0], /^netcase: /);
  // The takeover still ends: leaving it open would strand the machine.
  assert.equal((await read())?.state, "cancelled");
});

test("with no token there is nothing to sign in with, and it says so", async () => {
  await seedPending();
  await seedStoppedTarget();
  const res = await asUser(ADMIN, () => cancelTakeover());
  assert.deepEqual(res.left, ["netcase: no API token to sign in with"]);
});

test("the ports are not handed over for a migration that never finished", async () => {
  await seedPending();
  await assert.rejects(
    () => asUser(ADMIN, () => requestTakeover("nope")),
    /does not exist/,
  );
  await seedFinishedRun("run_live", "running");
  await assert.rejects(
    () => asUser(ADMIN, () => requestTakeover("run_live")),
    /is running/,
  );
  assert.equal((await read())?.state, "pending");
});

// The cutover stops that panel for good and nothing here can start it again, so
// a run that says another team is still owed holds the ports until the operator
// overrules it on purpose.
test("the ports wait for the teams the migration says are still owed", async () => {
  await seedPending();
  await seedFinishedRun("run_queued", "done", true);

  await assert.rejects(
    () => asUser(ADMIN, () => requestTakeover("run_queued")),
    /still has teams to bring over/,
  );
  assert.equal((await read())?.state, "pending");

  const after = await asUser(ADMIN, () =>
    requestTakeover("run_queued", { noOtherTeams: true }),
  );
  assert.equal(after.state, "ready");
});
