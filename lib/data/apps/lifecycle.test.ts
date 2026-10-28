import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../../db/test-harness";
import { __setTestDb, __resetTestDb } from "../../db/client";
import { apps } from "../../db/schema/control-plane/apps";
import { runWithIdentity } from "../../auth/request-context";
import { __setAgentConnectorForTest } from "../../infra/agent-client/connect";
import type { AgentConnection } from "../../infra/agent-client/connection";
import { seedIdentity, TEAM_A, USER_1 } from "../identity-test-helpers";
import { seedServerRow } from "../infra-test-helpers";
import { seedApp, TRUNCATE_PROJECT_GRAPH } from "../app-graph-test-helpers";
import { startApp } from "./lifecycle";

let db: TestDb;
let pg: PGlite;
let failStart = false;
let statusDuringStart: string | null = null;

const SRV = "srv_life";

const statusOf = async (id: string) =>
  (await db.select({ s: apps.status }).from(apps).where(eq(apps.id, id)))[0]?.s;

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
});

after(async () => {
  __setAgentConnectorForTest();
  __resetTestDb();
  await pg.close();
});

beforeEach(async () => {
  await pg.exec(`${TRUNCATE_PROJECT_GRAPH}
    truncate table activities, users, teams restart identity cascade;`);
  await seedIdentity(db, { users: [{ id: USER_1, teamId: TEAM_A }] });
  await seedServerRow(db, {
    id: SRV,
    name: "web-1",
    ip: "192.0.2.10",
    host: "192.0.2.10",
    agent: {
      port: 9443,
      certFingerprint: "fp",
      certPem: "-----BEGIN CERTIFICATE-----",
      version: "1.0.0",
    },
  });
  await seedApp(db, {
    id: "prj_web",
    slug: "web",
    serverId: SRV,
    status: "idle",
  });
  failStart = false;
  statusDuringStart = null;
  const conn = {
    hello: async () => ({ capabilities: [], agentVersion: "1.2.3" }),
    readStack: async () => ({ exists: false, yaml: "" }),
    startStack: async () => {
      statusDuringStart = (await statusOf("prj_web")) ?? null;
      return failStart
        ? { ok: false, error: "the daemon is busy" }
        : { ok: true, error: "" };
    },
    close: () => {},
  };
  __setAgentConnectorForTest(async () => conn as unknown as AgentConnection);
});

const asOwner = <T>(fn: () => Promise<T>) =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);

test("an app reads 'starting' while its stack starts, then 'active'", async () => {
  await asOwner(() => startApp("prj_web"));
  assert.equal(statusDuringStart, "starting");
  assert.equal(await statusOf("prj_web"), "active");
});

test("a start the server refuses puts the app back to stopped", async () => {
  failStart = true;
  await assert.rejects(
    asOwner(() => startApp("prj_web")),
    /was not started/,
  );
  assert.equal(statusDuringStart, "starting");
  assert.equal(await statusOf("prj_web"), "idle");
});
