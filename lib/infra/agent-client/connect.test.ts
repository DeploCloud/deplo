import { test, before, after } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../../db/test-harness";
import { __setTestDb, __resetTestDb } from "../../db/client";
import { servers } from "../../db/schema/control-plane/servers";
import { seedServerRow } from "../../data/infra-test-helpers";
import { AGENT_VERSION } from "../../version";
import type { AgentConnection } from "./connection";
import { gateConnection } from "./connect";
import { AGENT_TOO_OLD_MESSAGE, AgentTooOldError } from "./errors";

let db: TestDb;
let pg: PGlite;

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
  await seedServerRow(db, {
    id: "srv_gate",
    agent: { port: 9443, certFingerprint: "fp", certPem: "pem", version: "" },
  });
});

after(async () => {
  __resetTestDb();
  await pg.close();
});

function fakeConn(agentVersion: string) {
  const calls = { hello: 0, closed: 0 };
  const conn = {
    hello: async () => {
      calls.hello++;
      return { agentVersion };
    },
    close: () => void calls.closed++,
  } as unknown as AgentConnection;
  return { conn, calls };
}

const stored = async () =>
  (
    await db
      .select({ v: servers.agentVersion })
      .from(servers)
      .where(eq(servers.id, "srv_gate"))
  )[0].v;

test("a usable stored version costs no Hello", async () => {
  const { conn, calls } = fakeConn("0.0.1");
  assert.equal(await gateConnection(conn, AGENT_VERSION, "srv_gate"), conn);
  assert.equal(calls.hello, 0);
});

test("an unknown stored version asks the agent and remembers the answer", async () => {
  const { conn, calls } = fakeConn(AGENT_VERSION);
  assert.equal(await gateConnection(conn, "", "srv_gate"), conn);
  assert.equal(calls.hello, 1);
  assert.equal(calls.closed, 0);
  assert.equal(await stored(), AGENT_VERSION);
});

test("an agent below the minimum is refused, live, and the connection closed", async () => {
  const { conn, calls } = fakeConn("0.1.0");
  await assert.rejects(gateConnection(conn, "0.1.0", "srv_gate"), (e) => {
    assert.ok(e instanceof AgentTooOldError);
    assert.equal(e.message, AGENT_TOO_OLD_MESSAGE);
    return true;
  });
  assert.equal(calls.closed, 1);
  assert.equal(await stored(), "0.1.0");
});

test("a stale low stored version is not a refusal when the agent has moved on", async () => {
  const { conn } = fakeConn(AGENT_VERSION);
  assert.equal(await gateConnection(conn, "0.1.0", "srv_gate"), conn);
});
