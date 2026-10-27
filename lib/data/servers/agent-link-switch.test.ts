import { test, before, after, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";

import type { PGlite } from "@electric-sql/pglite";

import { makeTestDb, type TestDb } from "../../db/test-harness";
import { __setTestDb, __resetTestDb } from "../../db/client";
import { activities } from "../../db/schema/control-plane/activity";
import { deploMoves } from "../../db/schema/control-plane/deplo-move";
import { __resetReleaseCacheForTests } from "../../agent/release";
import { AGENT_VERSION } from "../../version";
import { nowIso } from "../../ids";
import type { DeployRequest } from "../../agent/gen/agent";
import { connectAgent } from "../../infra/agent-client/connect";
import { dropAgentChannel } from "../../infra/agent-client/channel-pool";
import { AgentNotLinkedError } from "../../infra/agent-client/errors";
import {
  AGENT_LINK_CAPABILITY,
  SELF_UPDATE_CAPABILITY,
} from "../../infra/agent-client/hello-capabilities";
import {
  eventually,
  startFakeAgent,
  type FakeAgent,
} from "../../infra/agent-client/fake-agent-test-helpers";
import {
  startAgentLinkListener,
  stopAgentLinkListener,
} from "../../infra/agent-link/listener";
import { LINK_SETTLE_MS } from "../../infra/agent-link/protocol";
import { currentLink, onAgentLink } from "../../infra/agent-link/registry";
import { invalidateFrozen } from "../deplo-move/freeze";
import { forgetRoutedFallback } from "../instance-settings/panel-fallback";
import { seedIdentity, TEAM_A, USER_1 } from "../identity-test-helpers";
import { seedServerRow, TRUNCATE_INFRA } from "../infra-test-helpers";
import { rolloutTiming, runAgentRollout } from "./agent-rollout";
import { startLinkAddressSync, stopLinkAddressSync } from "./link-addresses";

// Servers enrolled before the agent link move over on their own (ADR-0040): real agents, a real door.
const PANEL = "https://panel.example.com";
const FALLBACK = "https://deplo-cb00710a.deplo.site";
const SERVER = "srv_before_the_link";
const BEFORE_THE_LINK = "0.4.0";
const LINKING = [SELF_UPDATE_CAPABILITY, AGENT_LINK_CAPABILITY];

let db: TestDb;
let pg: PGlite;
let door: number;
let agent: FakeAgent | null = null;
const env: Record<string, string | undefined> = {};

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
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
  for (const k of ["DEPLO_PUBLIC_URL", "DEPLO_SERVER_IP"])
    env[k] = process.env[k];
  process.env.DEPLO_PUBLIC_URL = PANEL;
  process.env.DEPLO_SERVER_IP = "203.0.113.10";
  await pg.exec(`${TRUNCATE_INFRA}
    truncate table activities, users, teams restart identity cascade;`);
  await pg.exec("delete from instance_settings");
  await pg.exec("truncate table rate_limits");
  await seedIdentity(db, { users: [{ id: USER_1, teamId: TEAM_A }] });
  forgetRoutedFallback();
  // As at boot: the sync first, then the door.
  startLinkAddressSync();
  door = (await startAgentLinkListener({ port: 0, host: "127.0.0.1" })).port;
});

afterEach(async () => {
  await stopLinkAddressSync();
  await stopAgentLinkListener();
  dropAgentChannel(SERVER);
  await agent?.stop();
  agent = null;
  forgetRoutedFallback();
  for (const [k, v] of Object.entries(env))
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
});

/** An agent from before the link, enrolled over its own port; `reachesPanel` is whether it can link once updated. */
async function enrolled(
  opts: { reachesPanel?: boolean; version?: string; caps?: string[] } = {},
): Promise<FakeAgent> {
  agent = await startFakeAgent({
    version: opts.version ?? BEFORE_THE_LINK,
    capabilities: opts.caps ?? [SELF_UPDATE_CAPABILITY],
    linkAddresses: opts.caps
      ? { primary: PANEL, fallback: FALLBACK }
      : undefined,
    updatesTo: {
      version: AGENT_VERSION,
      capabilities: LINKING,
      // It finds no address saved: the panel sends one over its port.
      linkAddresses: { primary: "", fallback: "" },
    },
    door: opts.reachesPanel === false ? undefined : door,
  });
  await seedServerRow(db, {
    id: SERVER,
    name: SERVER,
    ip: "127.0.0.1",
    host: "127.0.0.1",
    agent: {
      port: agent.port,
      certFingerprint: agent.fingerprint,
      certPem: agent.certPem,
      version: opts.version ?? BEFORE_THE_LINK,
    },
  });
  return agent;
}

const refusesConnections = (port: number) =>
  new Promise<boolean>((resolve) => {
    const sock = net.connect(port, "127.0.0.1");
    sock.once("connect", () => {
      sock.destroy();
      resolve(false);
    });
    sock.once("error", () => resolve(true));
  });

async function relink(a: FakeAgent): Promise<void> {
  const up = new Promise<void>((resolve) => {
    const off = onAgentLink((e) => {
      if (e.serverId === SERVER && e.type === "up") resolve(void off());
    });
  });
  assert.equal((await a.link(door)).status, 101);
  await up;
}

async function hello() {
  const conn = await connectAgent(SERVER);
  try {
    return await conn.hello();
  } finally {
    conn.close();
  }
}

test("an agent updated to a linking release links and stops listening, with nothing for the user to do", async (t) => {
  const a = await enrolled();

  await runAgentRollout();

  await eventually(() => !a.listening(), 5_000);
  assert.deepEqual(a.sentPairs(), [{ primary: PANEL, fallback: FALLBACK }]);
  assert.ok(currentLink(SERVER), "it is linked");
  assert.ok(await refusesConnections(a.port), "its port is closed");
  const dialed = a.connections().opened;
  const h = await hello();
  assert.equal(h.agentVersion, AGENT_VERSION);
  assert.equal(h.listening, false);
  assert.equal(a.connections().opened, dialed, "reached over its link");
  const log = await db.select({ m: activities.message }).from(activities);
  assert.ok(log.some((r) => r.m.includes(`Updated the agent on ${SERVER}`)));

  // Deplo restarts, and links have settled: the server is waited for, never dialed, until it links again.
  await stopAgentLinkListener();
  door = (await startAgentLinkListener({ port: 0, host: "127.0.0.1" })).port;
  mock.timers.enable({ apis: ["Date"], now: Date.now() + LINK_SETTLE_MS });
  t.after(() => mock.timers.reset());
  const answer = hello();
  await new Promise((r) => setTimeout(r, 300));
  await relink(a);
  assert.equal((await answer).agentVersion, AGENT_VERSION);
  assert.equal(a.connections().opened, dialed, "never dialed again");
});

test("an agent that cannot reach the panel keeps its port, and its dial carries no deploy", async () => {
  const a = await enrolled({ reachesPanel: false });

  await runAgentRollout();
  await eventually(() => a.sentPairs().length > 0);
  await stopLinkAddressSync(); // everything already on its way has landed

  assert.equal(a.listening(), true);
  assert.equal(currentLink(SERVER), undefined);
  const h = await hello();
  assert.equal(h.agentVersion, AGENT_VERSION);
  assert.equal(h.listening, true);
  assert.equal(await refusesConnections(a.port), false);
  const conn = await connectAgent(SERVER);
  try {
    await assert.rejects(
      conn.deploy({} as DeployRequest).next(),
      AgentNotLinkedError,
    );
  } finally {
    conn.close();
  }
});

test("while a Deplo move has the instance frozen, a linked agent keeps its port until the move is over", async (t) => {
  await db.insert(deploMoves).values({
    id: "dmv_target",
    side: "target",
    state: "copying",
    peerUrl: "https://old.example.com",
    startedBy: USER_1,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  });
  invalidateFrozen();
  t.after(async () => {
    await pg.exec("delete from deplo_moves");
    invalidateFrozen();
  });
  const a = await enrolled({ version: AGENT_VERSION, caps: LINKING });
  const up = new Promise<void>((resolve) => {
    const off = onAgentLink((e) => {
      if (e.serverId === SERVER && e.type === "up") resolve(void off());
    });
  });
  await a.link(door);
  await up;
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(a.listening(), true, "asked to stop while frozen");

  await pg.exec("delete from deplo_moves");
  invalidateFrozen();
  await hello(); // the next Hello the panel sees
  await eventually(() => !a.listening());
});
