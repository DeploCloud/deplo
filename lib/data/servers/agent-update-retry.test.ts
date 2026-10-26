import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";

import { makeTestDb, type TestDb } from "../../db/test-harness";
import { __setTestDb, __resetTestDb } from "../../db/client";
import { activities } from "../../db/schema/control-plane/activity";
import { serverAgentUpdates } from "../../db/schema/control-plane/servers";
import { runWithIdentity } from "../../auth/request-context";
import { __setAgentConnectorForTest } from "../../infra/agent-client/connect";
import type { AgentConnection } from "../../infra/agent-client/connection";
import { __resetReleaseCacheForTests } from "../../agent/release";
import { AGENT_VERSION } from "../../version";
import { seedIdentity, TEAM_A, USER_1 } from "../identity-test-helpers";
import { seedServerRow } from "../infra-test-helpers";
import { retryServerAgentUpdate } from "./agent-maintenance";
import {
  fleetAgentStatus,
  rolloutTiming,
  runAgentRollout,
} from "./agent-rollout";
import { getAgentUpdate } from "./agent-update-state";

let db: TestDb;
let pg: PGlite;

interface FakeAgent {
  version: string;
  reachable: boolean;
  canSelfUpdate: boolean;
  comesBack: boolean;
  updates: number;
}
const agents = new Map<string, FakeAgent>();
const order: string[] = [];

function fakeConnector(id: string): Promise<AgentConnection> {
  const a = agents.get(id)!;
  return Promise.resolve({
    hello: async () => {
      if (!a.reachable) throw new Error("connect ECONNREFUSED");
      return {
        agentVersion: a.version,
        contractVersion: 1,
        capabilities: a.canSelfUpdate ? ["self-update"] : [],
      };
    },
    selfUpdate: async (version: string) => {
      a.updates++;
      order.push(id);
      if (a.comesBack) a.version = version;
      else a.reachable = false;
      return { version, restarting: true };
    },
    close: () => {},
  } as unknown as AgentConnection);
}

let fingerprints = 0;
async function server(
  id: string,
  version: string,
  agent: Partial<FakeAgent> = {},
  ip = `10.0.1.${++fingerprints}`,
) {
  agents.set(id, {
    version,
    reachable: true,
    canSelfUpdate: true,
    comesBack: true,
    updates: 0,
    ...agent,
  });
  await seedServerRow(db, {
    id,
    name: id,
    ip,
    agent: {
      certFingerprint: `fp_${id}`,
      certPem: "pem",
      version,
    },
  });
}

const asAdmin = <T>(fn: () => Promise<T>) =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
  process.env.DEPLO_SERVER_IP = "192.0.2.250";
  rolloutTiming.confirmTries = 2;
  rolloutTiming.confirmDelayMs = 0;
  (globalThis as Record<symbol, unknown>)[
    Symbol.for("deplo.agent.release.cache")
  ] = {
    value: {
      at: Date.now(),
      release: {
        version: AGENT_VERSION,
        binaries: { amd64: { url: "https://x/a", sha256: "a" }, arm64: null },
      },
    },
  };
});

after(async () => {
  __resetReleaseCacheForTests();
  __resetTestDb();
  await pg.close();
});

beforeEach(async () => {
  await pg.exec(
    `truncate table servers, activities, users, teams restart identity cascade;`,
  );
  await seedIdentity(db, { users: [{ id: USER_1, teamId: TEAM_A }] });
  agents.clear();
  order.length = 0;
  __setAgentConnectorForTest(fakeConnector);
});

afterEach(() => __setAgentConnectorForTest());

const messages = async () =>
  (
    await db
      .select({ m: activities.message, a: activities.actor })
      .from(activities)
  ).map((r) => `${r.a}: ${r.m}`);

test("an unreachable server fails on its own; the next one is still updated", async () => {
  await server("srv_dark", "0.4.0", { reachable: false });
  await server("srv_ok", "0.4.0");
  await runAgentRollout();
  assert.equal(agents.get("srv_ok")!.version, AGENT_VERSION);
  assert.equal(await getAgentUpdate("srv_ok"), null, "success leaves no row");
  const dark = (await getAgentUpdate("srv_dark"))!;
  assert.equal(dark.failure, "unreachable");
  assert.ok(dark.nextRetryAt);
  assert.ok(
    (await messages()).some((m) => m.includes("Updated the agent on srv_ok")),
  );
});

test("a server that does not come back pauses the rest until it recovers", async () => {
  await server("srv_a", "0.4.0", { comesBack: false });
  await server("srv_b", "0.4.0");
  await server("srv_c", "0.4.0");
  await runAgentRollout();
  assert.equal(order.length, 1, "the pass stops on the suspect");
  const suspect = order[0];
  assert.equal((await getAgentUpdate(suspect))!.failure, "no_return");
  const status = await asAdmin(() => fleetAgentStatus());
  assert.equal(status.pausedBy, suspect);

  // Due again: only the suspect is tried while it is paused.
  const others = ["srv_a", "srv_b", "srv_c"].filter((s) => s !== suspect);
  await db
    .update(serverAgentUpdates)
    .set({ nextRetryAt: new Date(0).toISOString() });
  agents.get(suspect)!.reachable = true;
  agents.get(suspect)!.comesBack = true;
  await runAgentRollout();
  assert.equal(agents.get(suspect)!.version, AGENT_VERSION);
  for (const o of others) assert.equal(agents.get(o)!.version, AGENT_VERSION);
});

test("an agent too old to update itself is a failure the button can retry", async () => {
  await server("srv_old", "0.1.0", { canSelfUpdate: false });
  await runAgentRollout();
  const row = (await getAgentUpdate("srv_old"))!;
  assert.equal(row.failure, "error");
  assert.match(row.lastError, /too old to update itself/);
  const log = await messages();
  assert.ok(log.some((m) => m.startsWith("Deplo: srv_old is unusable")));

  agents.get("srv_old")!.canSelfUpdate = true;
  const started = await asAdmin(() => retryServerAgentUpdate("srv_old"));
  assert.equal(started.running, true);
  await assert.rejects(
    asAdmin(() => retryServerAgentUpdate("srv_old")),
    /already running/,
  );
  for (let i = 0; i < 50 && (await getAgentUpdate("srv_old")); i++)
    await new Promise((r) => setTimeout(r, 10));
  assert.equal(await getAgentUpdate("srv_old"), null);
  assert.equal(
    (await messages()).filter((m) => m.includes("is unusable")).length,
    1,
    "announced once",
  );
});

test("the button is refused before Deplo has failed, and when nothing is behind", async () => {
  await server("srv_new", "0.4.0");
  await assert.rejects(
    asAdmin(() => retryServerAgentUpdate("srv_new")),
    /on its own/,
  );
  await server("srv_cur", AGENT_VERSION);
  await assert.rejects(
    asAdmin(() => retryServerAgentUpdate("srv_cur")),
    /Nothing to update/,
  );
});
