import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";

import type { PGlite } from "@electric-sql/pglite";

import { makeTestDb, type TestDb } from "../../db/test-harness";
import { __setTestDb, __resetTestDb } from "../../db/client";
import { deploMoves } from "../../db/schema/control-plane/deplo-move";
import { AGENT_VERSION } from "../../version";
import { nowIso } from "../../ids";
import { connectAgent } from "../../infra/agent-client/connect";
import { dropAgentChannel } from "../../infra/agent-client/channel-pool";
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
import { onAgentLink } from "../../infra/agent-link/registry";
import { invalidateFrozen } from "../deplo-move/freeze";
import { forgetRoutedFallback } from "../instance-settings/panel-fallback";
import { seedIdentity, TEAM_A, USER_1 } from "../identity-test-helpers";
import { seedServerRow, TRUNCATE_INFRA } from "../infra-test-helpers";
import { startLinkAddressSync, stopLinkAddressSync } from "./link-addresses";

// Servers enrolled before the agent link close their port on their own (ADR-0040): real agents, a real door.
const PANEL = "https://panel.example.com";
const FALLBACK = "https://deplo-cb00710a.deplo.site";
const SERVER = "srv_before_the_link";
const LINKING = [SELF_UPDATE_CAPABILITY, AGENT_LINK_CAPABILITY];

let db: TestDb;
let pg: PGlite;
let door: number;
let agent: FakeAgent | null = null;
const env: Record<string, string | undefined> = {};

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
});

after(async () => {
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

/** An agent installed before the link, updated to a linking release: it still listens on its own port. */
async function enrolled(): Promise<FakeAgent> {
  agent = await startFakeAgent({
    version: AGENT_VERSION,
    capabilities: LINKING,
    // Its install command's address, all it had saved.
    linkAddresses: { primary: PANEL, fallback: "" },
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
      version: AGENT_VERSION,
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

async function hello() {
  const conn = await connectAgent(SERVER);
  try {
    return await conn.hello();
  } finally {
    conn.close();
  }
}

function linkUp(): Promise<void> {
  return new Promise<void>((resolve) => {
    const off = onAgentLink((e) => {
      if (e.serverId === SERVER && e.type === "up") resolve(void off());
    });
  });
}

test("an agent installed before the link links in, then is told over its link to close its port, with nothing for the user to do", async () => {
  const a = await enrolled();
  const up = linkUp();
  await a.link(door);
  await up;

  await eventually(() => !a.listening(), 5_000);
  assert.deepEqual(a.sentPairs(), [{ primary: PANEL, fallback: FALLBACK }]);
  assert.ok(await refusesConnections(a.port), "its port is closed");
  const h = await hello();
  assert.equal(h.listening, false);
  assert.equal(a.connections().opened, 0, "nothing ever dialed it");
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
  const a = await enrolled();
  const up = linkUp();
  await a.link(door);
  await up;
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(a.listening(), true, "asked to stop while frozen");

  await pg.exec("delete from deplo_moves");
  invalidateFrozen();
  await hello(); // the next Hello the panel sees
  await eventually(() => !a.listening());
});
