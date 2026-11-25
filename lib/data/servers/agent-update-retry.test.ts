import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";

import { makeTestDb, type TestDb } from "../../db/test-harness";
import { __setTestDb, __resetTestDb } from "../../db/client";
import { activities } from "../../db/schema/control-plane/activity";
import { serverAgentUpdates } from "../../db/schema/control-plane/servers";
import {
  clusterDnsZones,
  clusterMembers,
  clusters,
} from "../../db/schema/control-plane/clusters";
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
  leaderHandOff,
  rolloutTiming,
  runAgentRollout,
} from "./agent-rollout";
import { getAgentUpdate } from "./agent-update-state";

let db: TestDb;
let pg: PGlite;

// Behind the pin, and new enough to link: what the rollout can still reach (ADR-0041).
const BEHIND = "0.5.1-canary.10";

interface FakeAgent {
  version: string;
  reachable: boolean;
  canSelfUpdate: boolean;
  comesBack: boolean;
  // goesBack: the new binary does not answer and the agent puts the one before it back (ADR-0043).
  goesBack?: boolean;
  // hellos left before it stops answering: an agent that dies after it came back.
  hellosLeft?: number;
  updates: number;
}
const agents = new Map<string, FakeAgent>();
const order: string[] = [];
const waits: number[] = [];
// What the leader on a server says of each member's lease, by cluster: its snapshot.
const leaderSays = new Map<string, Record<string, string>>();

function fakeConnector(id: string): Promise<AgentConnection> {
  const a = agents.get(id)!;
  return Promise.resolve({
    hello: async () => {
      if (a.hellosLeft !== undefined && a.hellosLeft-- <= 0)
        a.reachable = false;
      if (!a.reachable) throw new Error("connect ECONNREFUSED");
      return {
        agentVersion: a.version,
        contractVersion: 1,
        capabilities: a.canSelfUpdate ? ["self-update", "cluster.host"] : [],
      };
    },
    selfUpdate: async (version: string) => {
      a.updates++;
      order.push(id);
      if (a.goesBack) return { version, restarting: true };
      if (a.comesBack) a.version = version;
      else a.reachable = false;
      return { version, restarting: true };
    },
    clusterStatus: async () => ({
      installed: true,
      running: true,
      version: "9.9.9",
      relay: false,
      member: true,
      relayLinks: 1,
    }),
    clusterCall: async () => {
      const clusters = Object.fromEntries(
        [...leaderSays].map(([c, states]) => [
          c,
          {
            epoch: 1,
            superseded: false,
            members: Object.entries(states).map(([m, state]) => ({
              id: m,
              state,
              heard: true,
            })),
          },
        ]),
      );
      return new TextEncoder().encode(JSON.stringify({ head: 0, clusters }));
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
  linked = true,
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
    firstLinkedAt: linked ? "2026-10-29T00:00:00.000Z" : undefined,
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
  rolloutTiming.wait = async (ms) => void waits.push(ms);
  rolloutTiming.holdMs = 30;
  rolloutTiming.holdWait = async () => {
    await new Promise((r) => setTimeout(r, 5));
  };
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
    `truncate table servers, activities, users, teams, clusters restart identity cascade;`,
  );
  await seedIdentity(db, { users: [{ id: USER_1, teamId: TEAM_A }] });
  agents.clear();
  leaderSays.clear();
  order.length = 0;
  waits.length = 0;
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
  await server("srv_dark", BEHIND, { reachable: false });
  await server("srv_ok", BEHIND);
  await runAgentRollout();
  assert.equal(agents.get("srv_ok")!.version, AGENT_VERSION);
  assert.equal(await getAgentUpdate("srv_ok"), null, "success leaves no row");
  const dark = (await getAgentUpdate("srv_dark"))!;
  assert.equal(dark.failure, "unreachable");
  assert.ok(dark.nextRetryAt);
  assert.ok(
    (await messages()).some((m) =>
      m.includes("Updated the server agent on srv_ok"),
    ),
  );
});

test("a server that does not come back pauses the rest until it recovers", async () => {
  await server("srv_a", BEHIND, { comesBack: false });
  await server("srv_b", BEHIND);
  await server("srv_c", BEHIND);
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
  // A version Deplo has not heard yet: below the floor as far as it knows, and still able to link.
  await server("srv_old", "", { canSelfUpdate: false });
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
  await server("srv_new", BEHIND);
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

test("the button is refused for a server that hasn't connected to Deplo yet, and says what to check", async () => {
  await server("srv_blocked", "", {}, "10.0.1.99", false);
  await db.insert(serverAgentUpdates).values({
    serverId: "srv_blocked",
    status: "failed",
    failure: "unreachable",
    attempts: 3,
    targetVersion: AGENT_VERSION,
    updatedAt: "2026-10-28T00:00:00.000Z",
  });
  await assert.rejects(
    asAdmin(() => retryServerAgentUpdate("srv_blocked")),
    /can't reach Deplo/,
  );
  assert.equal(agents.get("srv_blocked")!.updates, 0);
});

test("a name server is given its silent time before the next server updates", async () => {
  await server("srv_ns", BEHIND);
  await server("srv_alone", BEHIND);
  const at = new Date().toISOString();
  await db.insert(clusters).values({
    id: "clu_1",
    name: "eu",
    createdAt: at,
    dnsDropAfter: 70,
    leaderServerId: "srv_alone",
  });
  leaderSays.set("clu_1", { srv_ns: "ok" });
  await db
    .insert(clusterMembers)
    .values({ serverId: "srv_ns", clusterId: "clu_1", joinedAt: at });
  await db.insert(clusterDnsZones).values({
    id: "czn_1",
    clusterId: "clu_1",
    name: "go.example.com",
    createdAt: at,
  });
  await runAgentRollout();
  assert.equal(agents.get("srv_ns")!.version, AGENT_VERSION);
  assert.equal(agents.get("srv_alone")!.version, AGENT_VERSION);
  assert.deepEqual(
    waits,
    [75_000 - 30],
    "the removal time and a margin past the minute it is held, after the name server only",
  );
});

const messagesNow = async () => (await messages()).join("\n");

// ADR-0043: a new binary that does not answer goes back to the one before it, and the rollout stops there.
test("a server back on the version it had stops the rollout, and is not tried again on its own", async () => {
  await server("srv_a", BEHIND, { goesBack: true });
  await server("srv_b", BEHIND);
  await runAgentRollout();
  assert.deepEqual(order, ["srv_a"], "nothing past the server that went back");
  const row = (await getAgentUpdate("srv_a"))!;
  assert.equal(row.failure, "no_return");
  assert.equal(row.nextRetryAt, null, "no retry of the same release");
  assert.match(
    row.lastError,
    /did not answer within 30 seconds, so it runs v0\.5\.1-canary\.10 again/,
  );
  assert.equal((await asAdmin(() => fleetAgentStatus())).pausedBy, "srv_a");
  assert.match(
    await messagesNow(),
    /Deplo stopped updating the other servers\.$/m,
  );

  await runAgentRollout();
  assert.deepEqual(order, ["srv_a"], "a later pass tries nobody");
});

// eu, 24 Nov 2026: a rollout went on while canary.47 was down on the servers before, its no_return worn away by a
// retry that found the server unreachable.
test("a retry that cannot reach the server keeps the rollout stopped", async () => {
  await server("srv_a", BEHIND, { comesBack: false });
  await server("srv_b", BEHIND);
  await runAgentRollout();
  agents.get("srv_a")!.comesBack = false;
  await db
    .update(serverAgentUpdates)
    .set({ nextRetryAt: new Date(0).toISOString() });
  await runAgentRollout();
  await runAgentRollout();
  assert.equal((await getAgentUpdate("srv_a"))!.failure, "no_return");
  assert.deepEqual(order, ["srv_a"], "srv_b waits");
  assert.equal((await asAdmin(() => fleetAgentStatus())).pausedBy, "srv_a");
});

test("a server that stops answering within its first minute stops the rollout", async () => {
  await server("srv_a", BEHIND, { hellosLeft: 3 });
  await server("srv_b", BEHIND);
  await runAgentRollout();
  assert.deepEqual(order, ["srv_a"]);
  const row = (await getAgentUpdate("srv_a"))!;
  assert.equal(row.failure, "no_return");
  assert.match(
    row.lastError,
    /but it stopped answering within its first minute/,
  );
  assert.doesNotMatch(await messagesNow(), /Updated the server agent on srv_a/);
});

test("a member whose leader stops renewing it within its first minute stops the rollout", async () => {
  await server("srv_m", BEHIND);
  await server("srv_lead", AGENT_VERSION);
  await server("srv_z", BEHIND);
  const at = new Date().toISOString();
  await db.insert(clusters).values({
    id: "clu_1",
    name: "eu",
    createdAt: at,
    leaderServerId: "srv_lead",
  });
  await db
    .insert(clusterMembers)
    .values({ serverId: "srv_m", clusterId: "clu_1", joinedAt: at });
  leaderSays.set("clu_1", { srv_m: "not_responding" });
  await runAgentRollout();
  assert.deepEqual(order, ["srv_m"]);
  assert.match(
    (await getAgentUpdate("srv_m"))!.lastError,
    /the leader of cluster eu stopped renewing it/,
  );
});

// eu, 24 Nov 2026: a Retry now on eu-4 was still in its minute when the pass updated eu-1.
test("a pass updates nobody while another server's update is under way", async () => {
  // srv_a already answers on the pin: it is in its minute, no longer behind.
  await server("srv_a", AGENT_VERSION);
  await server("srv_b", BEHIND);
  await db.insert(serverAgentUpdates).values({
    serverId: "srv_a",
    status: "running",
    failure: "no_return",
    attempts: 1,
    targetVersion: AGENT_VERSION,
    updatedAt: new Date().toISOString(),
  });
  await runAgentRollout();
  assert.deepEqual(order, [], "srv_b waits for srv_a's minute");
});

// c39: the leader restarted with its server's agent, and every member's renewal waited 2.4 s for it.
test("a cluster's leader goes to the next in line before its server's agent updates, and that server updates last", async () => {
  await server("srv_lead", BEHIND);
  await server("srv_heir", BEHIND);
  const at = new Date().toISOString();
  await db.insert(clusters).values({
    id: "clu_1",
    name: "eu",
    createdAt: at,
    leaderServerId: "srv_lead",
  });
  const run = leaderHandOff.run;
  leaderHandOff.run = async (id) => {
    order.push(`hand-off:${id}`);
    return [];
  };
  try {
    await runAgentRollout();
  } finally {
    leaderHandOff.run = run;
  }
  assert.deepEqual(order, [
    "hand-off:srv_heir",
    "srv_heir",
    "hand-off:srv_lead",
    "srv_lead",
  ]);
});
