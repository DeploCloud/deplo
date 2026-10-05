import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";

import { runWithIdentity } from "../../auth/request-context";
import { __resetTestDb, __setTestDb } from "../../db/client";
import journal from "../../db/migrations/meta/_journal.json";
import { makeTestDb, type TestDb } from "../../db/test-harness";
import { deploMoves } from "../../db/schema/control-plane/deplo-move";
import { MOVE_PROTOCOL } from "../../deplo-move/protocol";
import { __setAgentConnectorForTest } from "../../infra/agent-client/connect";
import { instanceFingerprint } from "../../migration/deplo/instance";
import {
  __resetMigrationFetchForTest,
  __setMigrationFetchForTest,
} from "../../migration/transport";
import { seedIdentity, TEAM_A, USER_1 } from "../identity-test-helpers";
import { seedServerRow } from "../infra-test-helpers";
import { invalidateFrozen } from "./freeze";
import {
  __setPortProbeForTest,
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
  fakeAgents,
  fakeOldDeplo,
  helloOf,
  stepsCalled,
  summary,
  type FakeOldDeplo,
} from "./target-test-helpers";

let db: TestDb;
let pg: PGlite;
let old: FakeOldDeplo;
let probed: string[] = [];
let blocked = new Set<string>();

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
  process.env.DEPLO_PUBLIC_URL = NEW;
  process.env.DEPLO_SERVER_IP = SELF_IP;
});

after(async () => {
  __resetMigrationFetchForTest();
  __setAgentConnectorForTest();
  __setPortProbeForTest();
  invalidateFrozen();
  __resetTestDb();
  await pg.close();
});

beforeEach(async () => {
  await pg.exec(`truncate table deplo_moves, deplo_move_servers, servers, apps,
    databases, activities, registration_links, membership_capabilities,
    memberships, users, teams, instance_settings restart identity cascade;`);
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
  const agents = fakeAgents();
  __setAgentConnectorForTest(agents.connector);
  old = fakeOldDeplo(agents, {
    hello: helloOf({
      servers: [summary({ id: "srv_web", name: "web" })],
    }),
  });
  __setMigrationFetchForTest(old.fetch);
  probed = [];
  blocked = new Set();
  __setPortProbeForTest(async (host, port) => {
    probed.push(`${host}:${port}`);
    return !blocked.has(host);
  });
  invalidateFrozen();
});

const asAdmin = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);

const connect = (url = OLD, code = MOVE_CODE) =>
  asAdmin(() => connectMove({ url, code }));

test("connecting previews the old Deplo and records one move, however often it is repeated", async () => {
  const first = await connect();
  assert.equal(first.canStart, true);
  assert.equal(first.peerUrl, OLD);
  assert.deepEqual(first.problems, []);
  assert.deepEqual(
    first.servers.map((s) => [s.id, s.problem]),
    [["srv_web", null]],
  );
  assert.deepEqual(probed, ["198.51.100.10:9443"]);

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

test("a Deplo that is not empty cannot receive a move", async () => {
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

test("a fresh Deplo is ready to receive a move", async () => {
  assert.deepEqual(await asAdmin(() => targetMoveReadiness()), {
    ready: true,
    reason: null,
  });
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

test("every server that cannot be handed over is listed, and the move cannot start", async () => {
  old.hello = helloOf({
    servers: [
      summary({ id: "srv_ok", name: "ok", address: "198.51.100.1" }),
      summary({
        id: "srv_down",
        name: "down",
        address: "198.51.100.2",
        reachable: false,
      }),
      summary({
        id: "srv_old",
        name: "dusty",
        address: "198.51.100.3",
        canHandOver: false,
      }),
      summary({ id: "srv_fw", name: "walled", address: "198.51.100.4" }),
      summary({ id: "srv_here", name: "here", address: SELF_IP }),
      summary({
        id: "srv_spare",
        name: "spare",
        address: "198.51.100.5",
        enrolled: false,
        port: null,
      }),
    ],
  });
  blocked.add("198.51.100.4");

  const preview = await connect();
  assert.equal(preview.canStart, false);
  const problem = Object.fromEntries(
    preview.servers.map((s) => [s.id, s.problem]),
  );
  assert.equal(problem.srv_ok, null);
  assert.equal(problem.srv_spare, null);
  assert.match(problem.srv_down ?? "", /cannot reach down/);
  assert.match(problem.srv_old ?? "", /dusty runs an older server agent/);
  assert.match(
    problem.srv_fw ?? "",
    /This machine cannot reach walled at 198\.51\.100\.4:9443/,
  );
  assert.match(problem.srv_here ?? "", /here is this machine/);
  assert.equal(preview.problems.length, 4);
  assert.deepEqual(preview.warnings, [
    "Passkeys and webhook addresses only keep working if old.deplo.test points at this Deplo after the move.",
    "spare never finished connecting, so it is copied as it is.",
  ]);

  await assert.rejects(
    () => asAdmin(() => startMove(preview.id)),
    (e: Error) => e.message === preview.problems[0],
  );
  assert.equal(stepsCalled(old).includes("freeze"), false);
});

test("a move's status is read by its id alone, and an unknown id has none", async () => {
  const preview = await connect();
  const status = await moveStatus(preview.id);
  assert.equal(status?.state, "connected");
  assert.equal(status?.peerUrl, OLD);
  assert.equal(status?.canCancel, true);
  assert.equal(status?.canRetry, false);
  assert.equal(status?.canFinishWithoutSource, false);
  assert.deepEqual(
    status?.steps.map((s) => s.state),
    ["waiting", "waiting", "waiting"],
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
