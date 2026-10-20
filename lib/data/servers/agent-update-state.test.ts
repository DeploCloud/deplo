import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";

import { makeTestDb, type TestDb } from "../../db/test-harness";
import { __setTestDb, __resetTestDb } from "../../db/client";
import { serverAgentUpdates } from "../../db/schema/control-plane/servers";
import { AGENT_VERSION } from "../../version";
import { seedServerRow } from "../infra-test-helpers";
import { markServerSeen } from "./agent-handshake";
import {
  GIVE_UP_MS,
  STALE_RUNNING_MS,
  claimAgentUpdate,
  dropStaleAgentUpdates,
  getAgentUpdate,
  nextRetryAt,
  recordAgentUpdateFailure,
  toAgentUpdateDTO,
} from "./agent-update-state";

let db: TestDb;
let pg: PGlite;
const ID = "srv_upd";
const T0 = new Date("2026-10-20T10:00:00Z");
const at = (ms: number) => new Date(T0.getTime() + ms);
const MIN = 60_000;

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
});

after(async () => {
  __resetTestDb();
  await pg.close();
});

beforeEach(async () => {
  await pg.exec(`truncate table servers restart identity cascade;`);
  await seedServerRow(db, {
    id: ID,
    agent: {
      port: 9443,
      certFingerprint: "fp",
      certPem: "pem",
      version: "0.1.0",
    },
  });
});

async function fail(
  now: Date,
  failure: "busy" | "unreachable" = "unreachable",
) {
  const row = (await getAgentUpdate(ID))!;
  return recordAgentUpdateFailure(row, failure, "boom", now);
}

test("backoff runs 1, 2, 4, 8 minutes and stops growing at an hour", () => {
  const mins = [1, 2, 3, 4, 7, 8, 20].map(
    (n) => (Date.parse(nextRetryAt(n, T0)) - T0.getTime()) / MIN,
  );
  assert.deepEqual(mins, [1, 2, 4, 8, 60, 60, 60]);
});

test("two claims at once: exactly one wins", async () => {
  const [a, b] = await Promise.all([
    claimAgentUpdate(ID, false, T0),
    claimAgentUpdate(ID, true, T0),
  ]);
  assert.equal([a, b].filter(Boolean).length, 1);
  assert.equal(
    await claimAgentUpdate(ID, true, T0),
    null,
    "busy until it settles",
  );
});

test("a running claim is taken back only once it is stale", async () => {
  await claimAgentUpdate(ID, false, T0);
  assert.equal(
    await claimAgentUpdate(ID, false, at(STALE_RUNNING_MS - 1)),
    null,
  );
  assert.ok(await claimAgentUpdate(ID, false, at(STALE_RUNNING_MS + 1)));
});

test("automatic waits for its retry time, manual does not", async () => {
  await claimAgentUpdate(ID, false, T0);
  const { firstFailure, gaveUp } = await fail(T0);
  assert.equal(firstFailure, true);
  assert.equal(gaveUp, false);
  assert.equal(await claimAgentUpdate(ID, false, at(30_000)), null);
  assert.ok(await claimAgentUpdate(ID, false, at(MIN)));
  await fail(at(MIN));
  const manual = await claimAgentUpdate(ID, true, at(MIN + 1));
  assert.ok(manual, "the button cancels the scheduled retry");
});

test("a manual failure keeps the 24 hours running, and the end of them stops automatic retries", async () => {
  await claimAgentUpdate(ID, false, T0);
  await fail(T0);
  await claimAgentUpdate(ID, true, at(10 * MIN));
  const manual = await fail(at(10 * MIN));
  assert.equal(manual.firstFailure, false);
  assert.equal(manual.row.firstFailedAt, T0.toISOString());
  assert.ok(manual.row.nextRetryAt, "automatic retries resume");

  await claimAgentUpdate(ID, true, at(GIVE_UP_MS));
  const last = await fail(at(GIVE_UP_MS));
  assert.equal(last.gaveUp, true);
  assert.equal(last.row.nextRetryAt, null);
  assert.equal(toAgentUpdateDTO(last.row).gaveUp, true);
  assert.equal(await claimAgentUpdate(ID, false, at(GIVE_UP_MS * 2)), null);
  assert.ok(
    await claimAgentUpdate(ID, true, at(GIVE_UP_MS * 2)),
    "the button stays",
  );
});

test("an unreachable server that comes back after the timeout gets one attempt, once", async () => {
  await claimAgentUpdate(ID, false, T0);
  await fail(T0);
  await claimAgentUpdate(ID, true, at(GIVE_UP_MS));
  await fail(at(GIVE_UP_MS));
  await markServerSeen(ID, "0.1.0");
  assert.ok(await claimAgentUpdate(ID, false), "revived");
  await fail(new Date(), "unreachable");
  await markServerSeen(ID, "0.1.0");
  assert.equal(await claimAgentUpdate(ID, false), null, "only once");
});

test("an agent seen on the pin closes the update; a new pin starts fresh", async () => {
  await claimAgentUpdate(ID, false, T0);
  await fail(T0);
  await markServerSeen(ID, AGENT_VERSION);
  assert.equal(await getAgentUpdate(ID), null);

  await claimAgentUpdate(ID, false, T0);
  await db.update(serverAgentUpdates).set({ targetVersion: "0.0.1" });
  await dropStaleAgentUpdates();
  assert.equal(await getAgentUpdate(ID), null);
});
