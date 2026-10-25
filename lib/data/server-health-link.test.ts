import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { deploMoves } from "../db/schema/control-plane/deplo-move";
import { servers } from "../db/schema/control-plane/servers";
import { runWithIdentity } from "../auth/request-context";
import { nowIso } from "../ids";
import { invalidateFrozen } from "./deplo-move/freeze";
import { seedIdentity, TEAM_A, USER_1 } from "./identity-test-helpers";
import { TRUNCATE_INFRA, seedServerRow } from "./infra-test-helpers";
import { getServerById } from "./servers/roster";
import {
  checkServerHealth,
  startServerLinkStatus,
  stopServerLinkStatus,
} from "./server-health";
import { HEALTH_MESSAGES } from "../infra/server-health";
import { dropAgentChannel } from "../infra/agent-client/channel-pool";
import {
  startFakeAgent,
  type FakeAgent,
  type FakeLink,
} from "../infra/agent-client/fake-agent-test-helpers";
import {
  startAgentLinkListener,
  stopAgentLinkListener,
} from "../infra/agent-link/listener";
import { onAgentLink } from "../infra/agent-link/registry";
import { AGENT_VERSION } from "../version";

const SERVER = "srv_linked";

let db: TestDb;
let pg: PGlite;
let agent: FakeAgent;
let door: number;

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
});

after(async () => {
  __resetTestDb();
  await pg.close();
});

beforeEach(async () => {
  await pg.exec(`${TRUNCATE_INFRA}
    truncate table users, teams restart identity cascade;`);
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner", isInstanceAdmin: true },
    ],
  });
  agent = await startFakeAgent();
  await seedAgentServer(SERVER, agent);
  door = (await startAgentLinkListener({ port: 0, host: "127.0.0.1" })).port;
});

afterEach(async () => {
  stopServerLinkStatus();
  await stopAgentLinkListener();
  dropAgentChannel(SERVER);
  await agent.stop();
});

async function seedAgentServer(id: string, a: FakeAgent): Promise<void> {
  await seedServerRow(db, {
    id,
    ip: "127.0.0.1",
    host: "127.0.0.1",
    status: "online",
    agent: {
      port: a.port,
      certFingerprint: a.fingerprint,
      certPem: a.certPem,
      version: AGENT_VERSION,
    },
  });
}

function linkEvent(type: "up" | "down", serverId = SERVER): Promise<void> {
  return new Promise((resolve) => {
    const off = onAgentLink((e) => {
      if (e.serverId !== serverId || e.type !== type) return;
      off();
      resolve();
    });
  });
}

async function linkIn(a = agent, serverId = SERVER): Promise<FakeLink> {
  const up = linkEvent("up", serverId);
  const link = await a.link(door);
  assert.equal(link.status, 101);
  await up;
  return link;
}

async function cut(link: FakeLink, serverId = SERVER): Promise<void> {
  const down = linkEvent("down", serverId);
  link.drop();
  await down;
}

async function shown(serverId = SERVER) {
  const s = (await getServerById(serverId))!;
  return {
    status: s.status,
    message: s.statusMessage ?? null,
    checkedAt: s.statusCheckedAt ?? null,
  };
}

async function until(
  check: () => Promise<boolean>,
  what: string,
  ms = 3_000,
): Promise<void> {
  const deadline = performance.now() + ms;
  while (!(await check())) {
    if (performance.now() > deadline) assert.fail(`never happened: ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

test(
  "a linked server shows offline once its link has been gone for about 10 s",
  { timeout: 20_000 },
  async () => {
    startServerLinkStatus();
    const link = await linkIn();

    await cut(link);
    const started = performance.now();
    await until(
      async () => (await shown()).status === "offline",
      "the server shows offline",
      13_000,
    );
    const waited = performance.now() - started;
    assert.ok(waited > 9_500 && waited < 12_000, `offline after ${waited} ms`);
    assert.equal((await shown()).message, HEALTH_MESSAGES.linkDown);
    assert.equal(agent.connections().opened, 0, "nothing dialed the agent");
  },
);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("the grace counts from the latest drop: a link that flaps is not offline", async () => {
  const GRACE = 1_500;
  startServerLinkStatus({ graceMs: GRACE });
  let link = await linkIn();

  await cut(link);
  const firstDrop = performance.now();
  link = await linkIn();
  await sleep(800 - (performance.now() - firstDrop));
  await cut(link);
  const secondDrop = performance.now();

  await sleep(GRACE + 200 - (performance.now() - firstDrop));
  assert.notEqual((await shown()).status, "offline", "offline too early");
  await until(
    async () => (await shown()).status === "offline",
    "offline once the second drop outlasts the grace",
  );
  assert.ok(performance.now() - secondDrop >= GRACE);
});

test("an offline server is back online as soon as it links again", async () => {
  startServerLinkStatus({ graceMs: 200 });
  await cut(await linkIn());
  await until(async () => (await shown()).status === "offline", "offline");
  const wentOffline = (await shown()).checkedAt!;

  await linkIn();
  await until(async () => (await shown()).status === "online", "online");
  const now = await shown();
  assert.equal(now.message, null);
  assert.ok(now.checkedAt! > wentOffline, "a newer observation");
  assert.equal(agent.connections().opened, 0, "nothing dialed the agent");
});

test("a server that links in with Docker down shows the warning its Hello gives", async (t) => {
  const dockerless = await startFakeAgent({ dockerAvailable: false });
  t.after(async () => {
    dropAgentChannel("srv_dockerless");
    await dockerless.stop();
  });
  await seedAgentServer("srv_dockerless", dockerless);
  startServerLinkStatus();

  await linkIn(dockerless, "srv_dockerless");
  await until(
    async () => (await shown("srv_dockerless")).status === "warning",
    "warning",
  );
  assert.equal(
    (await shown("srv_dockerless")).message,
    HEALTH_MESSAGES.dockerDown,
  );
});

test("while a Deplo move has the instance frozen, a link coming and going changes no status", async (t) => {
  await db.insert(deploMoves).values({
    id: "dmv_1",
    side: "target",
    state: "copying",
    startedBy: USER_1,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  });
  invalidateFrozen();
  t.after(async () => {
    await db.delete(deploMoves);
    invalidateFrozen();
  });
  startServerLinkStatus({ graceMs: 100 });
  const before = await shown();

  await cut(await linkIn());
  await sleep(400);
  assert.deepEqual(await shown(), before);
});

const asAdmin = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);

const AGED = new Date(Date.now() - 120_000).toISOString();

// Two minutes pass with no news: the Servers page shows Unknown, and a check is due.
async function ageObservation(serverId = SERVER): Promise<void> {
  await db
    .update(servers)
    .set({ statusCheckedAt: AGED, statusProbedAt: AGED })
    .where(eq(servers.id, serverId));
}

async function check(serverId = SERVER) {
  const started = performance.now();
  const s = await asAdmin(() => checkServerHealth(serverId, { force: true }));
  return { ...s, took: performance.now() - started };
}

test("checking a linked server asks its Hello over the link and never dials it", async (t) => {
  const dockerless = await startFakeAgent({ dockerAvailable: false });
  t.after(async () => {
    dropAgentChannel("srv_dockerless");
    await dockerless.stop();
  });
  await seedAgentServer("srv_dockerless", dockerless);
  await linkIn(dockerless, "srv_dockerless");

  const s = await check("srv_dockerless");
  assert.equal(s.status, "warning");
  assert.equal(s.statusMessage, HEALTH_MESSAGES.dockerDown);
  assert.equal(dockerless.connections().opened, 0, "nothing dialed the agent");
});

test("checking a server whose link stayed away shows it offline at once, without dialing it", async () => {
  startServerLinkStatus({ graceMs: 200 });
  await cut(await linkIn());
  await until(async () => (await shown()).status === "offline", "offline");
  await ageObservation();

  const s = await check();
  assert.ok(s.took < 1_500, `the check took ${s.took} ms`);
  assert.equal(s.status, "offline");
  assert.equal(s.statusMessage, HEALTH_MESSAGES.linkDown);
  assert.ok(s.statusCheckedAt! > AGED, "a fresh observation");
  assert.equal(agent.connections().opened, 0, "nothing dialed the agent");
});

test("checking a server whose link just dropped changes nothing until the grace is over", async () => {
  startServerLinkStatus();
  const link = await linkIn();
  await until(async () => (await shown()).checkedAt !== null, "linked");
  await ageObservation();
  const before = await shown();

  await cut(link);
  const s = await check();
  assert.ok(s.took < 1_500, `the check took ${s.took} ms`);
  assert.equal(s.status, "online");
  assert.deepEqual(await shown(), before);
  assert.equal(agent.connections().opened, 0, "nothing dialed the agent");
});

test("a server that never linked is checked as today: dialed, with no wait for a link", async () => {
  startServerLinkStatus();
  const up = await check();
  assert.equal(up.status, "online");
  assert.equal(agent.connections().opened, 1, "it was dialed");

  agent.refuse(true);
  await ageObservation();
  const down = await check();
  assert.ok(down.took < 3_000, `the check took ${down.took} ms`);
  assert.equal(down.status, "offline");
  assert.equal(down.statusMessage, HEALTH_MESSAGES.refused);
});
