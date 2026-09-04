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
import { seedDatabase } from "./backup-test-helpers";
import { seedServerRow } from "./infra-test-helpers";
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
  takeoverDataLoss,
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
  await db.execute("delete from databases;");
  await db.execute("delete from servers;");
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

// Before the cutover Deplo's proxy waits on loopback, so the configured https
// address is exactly the one that does not answer; the request came in through
// the old panel's proxy, and that is where a remote machine can enrol.
test("until the cutover, what Deplo hands out names the address it was reached on", async (t) => {
  const { instancePublicBaseUrl } = await import("./instance-settings");
  const previous = process.env.DEPLO_PUBLIC_URL;
  process.env.DEPLO_PUBLIC_URL = "https://deplo-abc.nip.io";
  t.after(() => {
    if (previous === undefined) delete process.env.DEPLO_PUBLIC_URL;
    else process.env.DEPLO_PUBLIC_URL = previous;
  });
  const sideDoor = new Headers({
    host: "deplo-abc.nip.io",
    "x-forwarded-proto": "http",
  });
  // No takeover: the configured address, whatever the request says.
  assert.equal(
    await asUser(ADMIN, () => instancePublicBaseUrl(sideDoor)),
    "https://deplo-abc.nip.io",
  );
  await seedPending();
  assert.equal(
    await asUser(ADMIN, () => instancePublicBaseUrl(sideDoor)),
    "http://deplo-abc.nip.io",
  );
  // Outside a request there is nothing to prefer, and the configured one answers.
  assert.equal(
    await asUser(ADMIN, () => instancePublicBaseUrl()),
    "https://deplo-abc.nip.io",
  );
  // Once the ports are Deplo's, the configured address is the one that answers.
  await asUser(ADMIN, () => requestTakeover(null, { discardData: true }));
  await asUser(ADMIN, () => markTakeoverProgress("done"));
  assert.equal(
    await asUser(ADMIN, () => instancePublicBaseUrl(sideDoor)),
    "https://deplo-abc.nip.io",
  );
});

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
    /already moved on|already over/,
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
    /already over/,
  );
});

test("a later host state is taken from ready and done: a lost report cannot strand the ladder", async () => {
  await seedPending();
  await seedFinishedRun("run_1");
  await asUser(ADMIN, () => requestTakeover("run_1"));
  // The host moved the ports and removed the panel, but its `done` and
  // `removing` never arrived (the panel was restarting under the removal).
  await asUser(ADMIN, () => markTakeoverProgress("removed"));
  assert.equal((await read())?.state, "removed");
});

test("a cutover that rolled back can be asked for again, and says why", async () => {
  await seedPending();
  await seedFinishedRun("run_1");
  await asUser(ADMIN, () => requestTakeover("run_1"));

  // The installer's report: the ports are back where they were, with the reason.
  await asUser(ADMIN, () =>
    markTakeoverProgress("failed", "Deplo did not answer after the move"),
  );
  let t = await read();
  assert.equal(t?.state, "failed");
  assert.equal(t?.error, "Deplo did not answer after the move");
  assert.equal(t?.runId, "run_1", "the run that finished is still the one");

  // Try again is the same request, and the reason goes with the failure.
  await asUser(ADMIN, () => requestTakeover("run_1", { noOtherTeams: true }));
  t = await read();
  assert.equal(t?.state, "ready");
  assert.equal(t?.error, null);

  // Only a cutover in flight can fail; a finished one cannot.
  await asUser(ADMIN, () => markTakeoverProgress("done"));
  await assert.rejects(
    () => asUser(ADMIN, () => markTakeoverProgress("failed", "late")),
    /already moved on|already over/,
  );
});

test("a service that arrived without its data holds the ports until the loss is accepted", async () => {
  await seedPending();
  await seedFinishedRun("run_1");
  // A database the run landed on whose copy failed: the marker on the row is
  // what says so, and the report's lines are how the run names it.
  await seedServerRow(db, {
    id: "srv_1",
    name: "box",
    ip: "203.0.113.7",
    host: "203.0.113.7",
  });
  await seedDatabase(db, { id: "db_1", name: "mxpg", serverId: "srv_1" });
  await db.execute(
    `update databases set data_copy_error = 'the copy failed' where id = 'db_1';`,
  );
  await db.execute(
    `insert into migration_run_items (id, run_id, path, source_kind, source_name, outcome, target_kind, target_id, message)
     values ('item_1', 'run_1', 'mx / production / mxpg', 'postgres', 'mxpg', 'created', 'database', 'db_1', null),
            ('item_2', 'run_1', 'mx / production / mxpg', 'volume', 'mxpg', 'failed', 'database', 'db_1', 'the copy failed'),
            ('item_3', 'run_1', 'mx / production / web', 'application', 'web', 'created', 'app', 'app_1', null);`,
  );
  await assert.rejects(
    () => asUser(ADMIN, () => requestTakeover("run_1")),
    /1 service arrived without its data \(mxpg\)/,
    "the old panel holds the only copy, so nothing moves on a default",
  );
  assert.equal((await read())?.state, "pending");
  await asUser(ADMIN, () => requestTakeover("run_1", { acceptDataLoss: true }));
  assert.equal((await read())?.state, "ready");
});

test("the loss list reads the live marker, so a copy run again clears it", async () => {
  await seedPending();
  await seedFinishedRun("run_1");
  await seedServerRow(db, {
    id: "srv_1",
    name: "box",
    ip: "203.0.113.7",
    host: "203.0.113.7",
  });
  await seedDatabase(db, { id: "db_1", name: "mxpg", serverId: "srv_1" });
  await db.execute(
    `update databases set data_copy_error = 'the copy failed' where id = 'db_1';`,
  );
  await db.execute(
    `insert into migration_run_items (id, run_id, path, source_kind, source_name, outcome, target_kind, target_id, message)
     values ('item_a', 'run_1', 'mx / production / mxpg', 'postgres', 'mxpg', 'created', 'database', 'db_1', null);`,
  );
  assert.deepEqual(await takeoverDataLoss("run_1"), ["mxpg"]);
  await db.execute(
    `update databases set data_copy_error = '' where id = 'db_1';`,
  );
  assert.deepEqual(await takeoverDataLoss("run_1"), []);
});

test("the machine is not taken, nor handed back, while a migration is still running", async () => {
  await seedPending();
  await seedFinishedRun("run_1");
  await seedFinishedRun("run_live", "running");
  await assert.rejects(
    () => asUser(ADMIN, () => requestTakeover("run_1")),
    /still running/,
  );
  await assert.rejects(
    () => asUser(ADMIN, () => requestTakeover(null, { discardData: true })),
    /still running/,
  );
  await assert.rejects(
    () => asUser(ADMIN, () => cancelTakeover()),
    /still running/,
  );
  await db.execute(
    `update migration_runs set status = 'done' where id = 'run_live';`,
  );
  await asUser(ADMIN, () => requestTakeover("run_1"));
  assert.equal((await read())?.state, "ready");
});

test("backing out is still open after a rollback", async () => {
  await seedPending();
  await asUser(ADMIN, () => requestTakeover(null, { discardData: true }));
  await asUser(ADMIN, () => markTakeoverProgress("failed", "no free port"));
  await asUser(ADMIN, () => cancelTakeover());
  assert.equal((await read())?.state, "cancelled");
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
    /is running|still running/,
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

/* ---- the clean install --------------------------------------------- */

// The operator keeps nothing, so there is no run to wait for. Deleting the other
// platform IS the errand, and this is the only door into it.
test("a clean takeover reaches ready with no run at all", async () => {
  await seedPending();
  const after = await asUser(ADMIN, () =>
    requestTakeover(null, { discardData: true }),
  );
  assert.equal(after.state, "ready");
  assert.equal(after.runId, null);
});

test("neither a run nor discardData takes nobody's ports", async () => {
  await seedPending();
  await assert.rejects(
    () => asUser(ADMIN, () => requestTakeover(null)),
    /does not exist/,
  );
  assert.equal((await read())?.state, "pending");
});

test("a clean takeover is still an instance admin's", async () => {
  await seedPending();
  await assert.rejects(() =>
    asUser(MEMBER, () => requestTakeover(null, { discardData: true })),
  );
  assert.equal((await read())?.state, "pending");
});
