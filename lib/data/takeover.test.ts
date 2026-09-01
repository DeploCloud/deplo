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
  cancelTakeover,
  ensureTakeoverFromEnv,
  markTakeoverProgress,
  noteBrowserReached,
  requestPlatformRemoval,
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
  await asUser(ADMIN, () => requestTakeover("run_1"));
  // Boot again with the same env var still set, as every restart does.
  await asUser(ADMIN, ensureTakeoverFromEnv);
  assert.equal((await read())?.state, "ready");
});

test("the ladder only ever goes forward", async () => {
  await seedPending();
  await asUser(ADMIN, () => requestTakeover("run_1"));
  assert.equal((await read())?.runId, "run_1");

  // `done` is the installer's to report, and only from `ready`.
  await asUser(ADMIN, () => markTakeoverProgress("done"));
  assert.equal((await read())?.state, "done");

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

  await asUser(ADMIN, requestPlatformRemoval);
  assert.equal((await read())?.state, "removing");
  await asUser(ADMIN, () => markTakeoverProgress("removed"));
  assert.equal((await read())?.state, "removed");
  await assert.rejects(
    () => asUser(ADMIN, requestPlatformRemoval),
    /cannot move to "removing"/,
  );
});

test("the dashboard opens again once the ports are Deplo's", async () => {
  await seedPending();
  await asUser(ADMIN, () => requestTakeover("run_1"));
  await asUser(ADMIN, () => markTakeoverProgress("done"));
  assert.equal(
    await runWithIdentity(
      { userId: ADMIN, teamId: TEAM_A },
      takeoverBlocksDashboard,
    ),
    false,
    "the old platform is still on the disk, but nothing is in the way any more",
  );
});

test("only an instance admin decides any of it", async () => {
  await seedPending();
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
