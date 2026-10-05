import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { runWithIdentity } from "../../auth/request-context";
import { __resetTestDb, __setTestDb } from "../../db/client";
import journal from "../../db/migrations/meta/_journal.json";
import { makeTestDb, type TestDb } from "../../db/test-harness";
import {
  deploMoves,
  deploMoveServers,
} from "../../db/schema/control-plane/deplo-move";
import { MOVE_PROTOCOL } from "../../deplo-move/protocol";
import { instanceFingerprint } from "../../migration/deplo/instance";
import {
  __resetMigrationFetchForTest,
  __setMigrationFetchForTest,
} from "../../migration/transport";
import { seedIdentity, TEAM_A, USER_1 } from "../identity-test-helpers";
import { seedServerRow } from "../infra-test-helpers";
import { invalidateFrozen } from "./freeze";
import { __setRestorerForTest, __waitForMoveForTest } from "./runner";
import {
  DOMAINS_WARNING,
  cancelMove,
  connectMove,
  currentTargetMove,
  finishMoveWithoutSource,
  moveStatus,
  retryMove,
  startMove,
  targetMoveReadiness,
} from "./target";
import {
  MOVE_CODE,
  NEW,
  OLD,
  SELF_IP,
  fakeOldDeplo,
  helloOf,
  stepsCalled,
  summary,
  type FakeOldDeplo,
} from "./target-test-helpers";

let db: TestDb;
let pg: PGlite;
let old: FakeOldDeplo;

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
  process.env.DEPLO_PUBLIC_URL = NEW;
  process.env.DEPLO_SERVER_IP = SELF_IP;
});

after(async () => {
  __resetMigrationFetchForTest();
  __setRestorerForTest();
  invalidateFrozen();
  __resetTestDb();
  await pg.close();
});

beforeEach(async () => {
  await pg.exec(`truncate table deplo_moves, deplo_move_servers,
    deplo_move_workloads, servers, apps, databases, activities,
    registration_links, membership_capabilities, memberships, users, teams,
    instance_settings restart identity cascade;`);
  await seedIdentity(db, {
    teams: [{ id: TEAM_A, slug: "alpha" }],
    users: [{ id: USER_1, teamId: TEAM_A, role: "owner" }],
  });
  await seedServerRow(db, {
    id: "srv_self",
    name: "this-machine",
    ip: SELF_IP,
    host: SELF_IP,
  });
  old = fakeOldDeplo({
    hello: helloOf({
      servers: [summary({ id: "srv_web", name: "web", apps: 1 })],
    }),
  });
  __setMigrationFetchForTest(old.fetch);
  invalidateFrozen();
});

const asAdmin = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);

const connect = (url = OLD, code = MOVE_CODE) =>
  asAdmin(() => connectMove({ url, code }));

test("connecting previews the old Deplo, maps its servers onto this machine, and records one move", async () => {
  const first = await connect();
  assert.equal(first.canStart, true);
  assert.equal(first.peerUrl, OLD);
  assert.deepEqual(first.problems, []);
  assert.deepEqual(
    first.servers.map((s) => [s.id, s.target, s.choices, s.problem]),
    [["srv_web", "srv_self", ["srv_self"], null]],
  );
  assert.deepEqual(first.targets, [
    {
      id: "srv_self",
      name: "this-machine",
      address: SELF_IP,
      isThisMachine: true,
      canHostWorkloads: true,
    },
  ]);
  assert.deepEqual(first.warnings, [
    DOMAINS_WARNING,
    "Passkeys and webhook addresses only keep working if old.deplo.test points at this Deplo after the move.",
  ]);

  const again = await connect(`${OLD}/`);
  assert.equal(again.id, first.id);
  const rows = await db.select().from(deploMoves);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, "connected");
  assert.equal(rows[0].side, "target");
  assert.notEqual(rows[0].codeEnc, MOVE_CODE);
  assert.equal(await asAdmin(() => currentTargetMove()), first.id);
});

test("a plain http address is refused before anything is sent", async () => {
  await assert.rejects(
    () => connect("http://old.deplo.test"),
    /Use the old Deplo's https address/,
  );
  assert.deepEqual(old.calls, []);
});

test("an address without a scheme is taken as https", async () => {
  const preview = await connect("old.deplo.test");
  assert.equal(preview.peerUrl, OLD);
});

test("something that is not a move code is refused", async () => {
  await assert.rejects(() => connect(OLD, "deplo_abc"), /not a move code/);
  assert.deepEqual(old.calls, []);
});

test("only an instance admin can connect", async () => {
  await pg.exec(
    `update users set is_instance_admin = false where id = '${USER_1}'`,
  );
  await assert.rejects(() => connect(), /instance admin/);
});

test("connecting this Deplo to itself is refused", async () => {
  old.hello.instance = instanceFingerprint();
  await assert.rejects(() => connect(), /That address is this Deplo/);
});

test("a Deplo with a second account cannot receive a move, but servers of its own are fine", async () => {
  await seedServerRow(db, {
    id: "srv_spare",
    name: "spare",
    ip: "203.0.113.9",
    host: "203.0.113.9",
  });
  assert.deepEqual(await asAdmin(() => targetMoveReadiness()), {
    ready: true,
    reason: null,
  });
  await seedIdentity(db, {
    teams: [{ id: "team_two", slug: "two" }],
    users: [{ id: "user_two", teamId: "team_two", role: "owner" }],
  });
  await assert.rejects(() => connect(), /Needs an empty Deplo/);
  assert.deepEqual(old.calls, []);
  const ready = await asAdmin(() => targetMoveReadiness());
  assert.equal(ready.ready, false);
  assert.match(ready.reason ?? "", /Bring only some teams instead/);
});

test("a schema mismatch names the Deplo to update", async () => {
  old.hello.schema = journal.entries[0].tag;
  await assert.rejects(
    () => connect(),
    /The old Deplo runs an older version \(0\.5\.0\): update it/,
  );
  old.hello.schema = "9999_from_the_future";
  await assert.rejects(() => connect(), /update this Deplo/);
  old.hello.schema = journal.entries.at(-1)!.tag;
  old.hello.protocol = MOVE_PROTOCOL + 1;
  await assert.rejects(() => connect(), /update this Deplo/);
});

test("the old Deplo's refusal is shown as it said it", async () => {
  old.fail.hello = {
    status: 401,
    error: "This move code is not valid. Create a new one on the old Deplo.",
  };
  await assert.rejects(
    () => connect(),
    (e: Error) =>
      e.message ===
      "This move code is not valid. Create a new one on the old Deplo.",
  );
});

test("each old server is offered the servers here its role allows", async () => {
  await seedServerRow(db, {
    id: "srv_big",
    name: "big",
    ip: "203.0.113.1",
    host: "203.0.113.1",
  });
  await seedServerRow(db, {
    id: "srv_vault",
    name: "vault",
    ip: "203.0.113.2",
    host: "203.0.113.2",
    storageOnly: true,
  });
  // Also one of the old Deplo's own servers: never a place to land.
  await seedServerRow(db, {
    id: "srv_shared",
    name: "shared",
    ip: "198.51.100.40",
    host: "198.51.100.40",
  });
  old.hello = helloOf({
    servers: [
      summary({ id: "srv_web", name: "web", apps: 2, databases: 1 }),
      summary({
        id: "srv_bak",
        name: "bak",
        address: "198.51.100.30",
        role: "storage",
      }),
      summary({
        id: "srv_builder",
        name: "builder",
        address: "198.51.100.31",
        role: "build",
      }),
      summary({
        id: "srv_other",
        name: "other",
        address: "198.51.100.40",
        role: "import",
      }),
    ],
  });
  const preview = await connect();
  const by = Object.fromEntries(preview.servers.map((s) => [s.id, s]));
  assert.deepEqual(by.srv_web.choices.sort(), ["srv_big", "srv_self"]);
  assert.equal(by.srv_web.target, "srv_self");
  assert.deepEqual(by.srv_bak.choices.sort(), [
    "srv_big",
    "srv_self",
    "srv_vault",
  ]);
  assert.equal(by.srv_builder.target, "srv_self");
  assert.deepEqual(by.srv_builder.choices.sort(), ["srv_big", "srv_self"]);
  assert.deepEqual([by.srv_other.target, by.srv_other.choices], [null, []]);
  assert.deepEqual(preview.targets.map((t) => t.id).sort(), [
    "srv_big",
    "srv_self",
    "srv_vault",
  ]);
  assert.equal(preview.canStart, true);
});

test("an old server on this very machine, or with nowhere to go, blocks the move", async () => {
  await pg.exec(`update servers set storage_only = true where id = 'srv_self'`);
  old.hello = helloOf({
    servers: [
      summary({ id: "srv_web", name: "web", apps: 1 }),
      summary({ id: "srv_here", name: "here", address: SELF_IP }),
    ],
  });
  const preview = await connect();
  assert.equal(preview.canStart, false);
  const problem = Object.fromEntries(
    preview.servers.map((s) => [s.id, s.problem]),
  );
  assert.match(
    problem.srv_web ?? "",
    /No server here can run apps in place of web: add one under Servers/,
  );
  assert.match(problem.srv_here ?? "", /here is this machine/);
  await assert.rejects(
    () => asAdmin(() => startMove(preview.id)),
    (e: Error) => e.message === preview.problems[0],
  );
  assert.equal(stepsCalled(old).includes("dump"), false);
});

test("an old server its Deplo cannot reach is a warning, not a block", async () => {
  old.hello = helloOf({
    servers: [
      summary({ id: "srv_web", name: "web", apps: 1, reachable: false }),
    ],
  });
  const preview = await connect();
  assert.equal(preview.canStart, true);
  assert.ok(
    preview.warnings.includes(
      "The old Deplo cannot reach web right now, so its data cannot be copied until it is back.",
    ),
  );
});

test("starting stores the server map, and refuses a map the roles do not allow", async () => {
  await seedServerRow(db, {
    id: "srv_vault",
    name: "vault",
    ip: "203.0.113.2",
    host: "203.0.113.2",
    storageOnly: true,
  });
  await seedServerRow(db, {
    id: "srv_big",
    name: "big",
    ip: "203.0.113.1",
    host: "203.0.113.1",
  });
  old.hello = helloOf({
    servers: [
      summary({ id: "srv_web", name: "web", apps: 1 }),
      summary({
        id: "srv_bak",
        name: "bak",
        address: "198.51.100.30",
        role: "storage",
      }),
      summary({
        id: "srv_builder",
        name: "builder",
        address: "198.51.100.31",
        role: "build",
      }),
    ],
  });
  const preview = await connect();
  await assert.rejects(
    () =>
      asAdmin(() =>
        startMove(preview.id, [{ from: "srv_web", to: "srv_vault" }]),
      ),
    /web holds apps or databases, so it needs a server here that runs apps/,
  );
  await assert.rejects(
    () =>
      asAdmin(() => startMove(preview.id, [{ from: "srv_nope", to: null }])),
    /names a server the old Deplo does not have/,
  );
  await assert.rejects(
    () =>
      asAdmin(() =>
        startMove(preview.id, [{ from: "srv_builder", to: "srv_vault" }]),
      ),
    /builder needs a server here that can build apps/,
  );
  await assert.rejects(
    () => asAdmin(() => startMove(preview.id, [{ from: "srv_bak", to: null }])),
    /bak needs a server here that can keep backups/,
  );
  assert.equal(await db.$count(deploMoveServers), 0);

  // The copy itself is not under test here: it stops at once.
  __setRestorerForTest(async () => {
    throw new Error("Stopped for the test.");
  });
  const status = await asAdmin(() =>
    startMove(preview.id, [
      { from: "srv_web", to: "srv_big" },
      { from: "srv_bak", to: "srv_vault" },
      { from: "srv_builder", to: "srv_big" },
    ]),
  );
  await __waitForMoveForTest();
  assert.deepEqual(
    status.servers.map((s) => [s.id, s.targetId, s.targetName]),
    [
      ["srv_web", "srv_big", "big"],
      ["srv_bak", "srv_vault", "vault"],
      ["srv_builder", "srv_big", "big"],
    ],
  );
  const stored = await db
    .select()
    .from(deploMoveServers)
    .where(eq(deploMoveServers.moveId, preview.id))
    .orderBy(deploMoveServers.position);
  assert.deepEqual(
    stored.map((s) => [s.serverId, s.targetServerId]),
    [
      ["srv_web", "srv_big"],
      ["srv_bak", "srv_vault"],
      ["srv_builder", "srv_big"],
    ],
  );
});

test("a move's status is read by its id alone, and an unknown id has none", async () => {
  const preview = await connect();
  const status = await moveStatus(preview.id);
  assert.equal(status?.state, "connected");
  assert.equal(status?.peerUrl, OLD);
  assert.equal(status?.canCancel, true);
  assert.equal(status?.canRetry, false);
  assert.equal(status?.canFinishWithoutSource, false);
  assert.deepEqual(status?.workloads, []);
  assert.deepEqual(
    status?.steps.map((s) => [s.key, s.state]),
    [
      ["copy", "waiting"],
      ["deploy", "waiting"],
      ["finish", "waiting"],
    ],
  );

  assert.equal(await moveStatus("dmv_nope"), null);
  await assert.rejects(() => retryMove("dmv_nope"), /no such move/);
  await assert.rejects(() => cancelMove("dmv_nope"), /no such move/);
  await assert.rejects(() => retryMove(preview.id), /has not started yet/);
  await assert.rejects(
    () => finishMoveWithoutSource(preview.id),
    /stopped after the copy/,
  );
  assert.deepEqual(stepsCalled(old), ["hello"], "refused before asking");
});

test("two databases that would answer at one address on one server here block the move until the map separates them", async () => {
  await seedServerRow(db, {
    id: "srv_big",
    name: "big",
    ip: "203.0.113.1",
    host: "203.0.113.1",
  });
  old.hello = helloOf({
    servers: [
      summary({
        id: "srv_web",
        name: "web",
        databases: 1,
        databaseHosts: [{ id: "db_one", name: "main", host: "db-main" }],
      }),
      summary({
        id: "srv_two",
        name: "two",
        address: "198.51.100.20",
        databases: 2,
        databaseHosts: [
          { id: "db_two", name: "main", host: "db-main" },
          { id: "db_cache", name: "cache", host: "db-cache" },
        ],
      }),
    ],
  });
  const clash =
    "The databases main (on web) and main (on two) both answer at db-main, so they cannot share this-machine: choose another server here for web or two.";
  const preview = await connect();
  assert.equal(preview.canStart, false);
  assert.deepEqual(preview.problems, [clash]);
  assert.deepEqual(
    preview.servers.map((s) => [s.problem, s.databaseHosts.map((d) => d.host)]),
    [
      [null, ["db-main"]],
      [null, ["db-main", "db-cache"]],
    ],
  );
  await assert.rejects(
    () => asAdmin(() => startMove(preview.id)),
    (e: Error) => e.message === clash,
  );
  assert.equal(await db.$count(deploMoveServers), 0);
  assert.equal(stepsCalled(old).includes("dump"), false);

  __setRestorerForTest(async () => {
    throw new Error("Stopped for the test.");
  });
  const status = await asAdmin(() =>
    startMove(preview.id, [{ from: "srv_two", to: "srv_big" }]),
  );
  await __waitForMoveForTest();
  assert.deepEqual(
    status.servers.map((s) => [s.id, s.targetId]),
    [
      ["srv_web", "srv_self"],
      ["srv_two", "srv_big"],
    ],
  );
});
