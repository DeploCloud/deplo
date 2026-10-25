import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";

import { makeTestDb, type TestDb } from "../../db/test-harness";
import { __setTestDb, __resetTestDb } from "../../db/client";
import { seedServerRow, TRUNCATE_INFRA } from "../infra-test-helpers";
import { instanceSettings } from "../../db/schema/control-plane/instance";
import { deploMoves } from "../../db/schema/control-plane/deplo-move";
import { invalidateFrozen } from "../deplo-move/freeze";
import { withPanelRoute } from "../../deploy/traefik-stack";
import { __setRunsInContainerForTest } from "../../deploy/domains";
import { forgetRoutedFallback } from "../instance-settings/panel-fallback";
import type { HelloResponse } from "../../agent/gen/agent";
import { __setAgentConnectorForTest } from "../../infra/agent-client/connect";
import type { AgentConnection } from "../../infra/agent-client/connection";
import { AGENT_LINK_CAPABILITY } from "../../infra/agent-client/hello-capabilities";
import { agentHelloSeen } from "./link-addresses";

const PANEL = "https://panel.example.com";
const HOST_IP = "203.0.113.10";
// deplo.site resolves deplo-<hex IP> to that IP: this is the Deplo host's generated name.
const FALLBACK = "https://deplo-cb00710a.deplo.site";
const REMOTE = "srv_remote";
const TRAEFIK_STACK = `services:
  traefik:
    image: traefik:v3.7
    container_name: deplo-traefik
`;

let db: TestDb;
let pg: PGlite;
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
  for (const k of ["DEPLO_PUBLIC_URL", "DEPLO_SERVER_IP", "DEPLO_LINK_PORT"])
    env[k] = process.env[k];
  process.env.DEPLO_PUBLIC_URL = PANEL;
  process.env.DEPLO_SERVER_IP = HOST_IP;
  delete process.env.DEPLO_LINK_PORT;
  await pg.exec(TRUNCATE_INFRA);
  await pg.exec("delete from instance_settings");
  forgetRoutedFallback();
  await seedServerRow(db, {
    id: REMOTE,
    ip: "198.51.100.7",
    host: "198.51.100.7",
  });
});

afterEach(() => {
  __setAgentConnectorForTest();
  for (const [k, v] of Object.entries(env))
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
});

type Pair = { primary: string; fallback: string };

// Servers asked to close their own port.
const stopped: string[] = [];

/** Every server answers with a linking agent; returns the pairs each one was sent. */
function linkingAgents(panelProxy?: string): Map<string, Pair[]> {
  const sent = new Map<string, Pair[]>();
  stopped.length = 0;
  __setAgentConnectorForTest(async (serverId) => {
    const conn = {
      hello: async () => hello(undefined, [AGENT_LINK_CAPABILITY, "hostops"]),
      hostInfo: async () => ({ traefikComposeYaml: panelProxy ?? "" }),
      setLinkAddresses: async (pair: Pair) => {
        sent.set(serverId, [...(sent.get(serverId) ?? []), pair]);
        return pair;
      },
      stopListening: async () => void stopped.push(serverId),
      close: () => {},
    };
    return conn as unknown as AgentConnection;
  });
  return sent;
}

function hello(
  linkAddresses?: Pair,
  capabilities = [AGENT_LINK_CAPABILITY],
): HelloResponse {
  return {
    contractVersion: 1,
    agentVersion: "0.6.0",
    dockerAvailable: true,
    dockerVersion: "29.0.0",
    capabilities,
    traefikRunning: true,
    hostArch: "amd64",
    publicAddresses: [],
    linkAddresses,
    // Still on its own port, as every agent that moved from before the link is.
    listening: true,
  };
}

test("an agent that reports another pair is sent the panel's address and its fallback", async () => {
  const sent = linkingAgents();
  await agentHelloSeen(
    REMOTE,
    hello({ primary: "https://old.example.com", fallback: "" }),
  );
  assert.deepEqual(sent.get(REMOTE), [{ primary: PANEL, fallback: FALLBACK }]);
});

test("the fallback an agent is sent is the name the panel's proxy answers on", async () => {
  await seedServerRow(db, { id: "srv_panel", ip: HOST_IP, host: HOST_IP });
  // Installed before deplo.site: the proxy still routes the old generated name.
  const proxy = withPanelRoute(TRAEFIK_STACK, {
    domain: "panel.example.com",
    fallbackDomain: "deplo-cb00710a.nip.io",
    https: true,
    certResolver: "letsencrypt",
    target: "http://deplo:3000",
  });
  const sent = linkingAgents(proxy);
  await agentHelloSeen(REMOTE, hello({ primary: PANEL, fallback: FALLBACK }));
  assert.deepEqual(sent.get(REMOTE), [
    { primary: PANEL, fallback: "https://deplo-cb00710a.nip.io" },
  ]);
});

test("an agent that already keeps the panel's pair is sent nothing", async () => {
  const sent = linkingAgents();
  await agentHelloSeen(REMOTE, hello({ primary: PANEL, fallback: FALLBACK }));
  assert.equal(sent.size, 0);
});

test("an agent seen over its own port keeps that port until the panel has seen it link", async () => {
  const sent = linkingAgents();
  await agentHelloSeen(
    REMOTE,
    hello({ primary: "https://old.example.com", fallback: "" }),
  );
  await agentHelloSeen(REMOTE, hello({ primary: PANEL, fallback: FALLBACK }));
  assert.deepEqual(sent.get(REMOTE), [{ primary: PANEL, fallback: FALLBACK }]);
  assert.deepEqual(stopped, [], "never asked to stop listening");
});

test("an agent that does not link is never sent a pair", async () => {
  const sent = linkingAgents();
  await agentHelloSeen(REMOTE, hello(undefined, ["self-update"]));
  await agentHelloSeen(REMOTE, hello({ primary: "", fallback: "" }, []));
  assert.equal(sent.size, 0);
});

test("the panel's own server links over loopback and is never sent a public address", async () => {
  await seedServerRow(db, { id: "srv_panel", ip: HOST_IP, host: HOST_IP });
  const sent = linkingAgents();
  // Enrolled before the link had its own port, it saved the dashboard's.
  await agentHelloSeen(
    "srv_panel",
    hello({ primary: "http://127.0.0.1:3000", fallback: "" }),
  );
  await agentHelloSeen(
    "srv_panel",
    hello({ primary: PANEL, fallback: FALLBACK }),
  );
  assert.deepEqual(sent.get("srv_panel"), [
    { primary: "http://127.0.0.1:3001", fallback: "" },
    { primary: "http://127.0.0.1:3001", fallback: "" },
  ]);
});

test("a new panel domain leaves the panel's own server on loopback", async () => {
  await seedServerRow(db, { id: "srv_panel", ip: HOST_IP, host: HOST_IP });
  const sent = linkingAgents();
  const old = { primary: "https://old.example.com", fallback: "" };
  await agentHelloSeen("srv_panel", hello(old));
  process.env.DEPLO_PUBLIC_URL = "https://new.example.com";
  await agentHelloSeen("srv_panel", hello(old));
  const loopback = { primary: "http://127.0.0.1:3001", fallback: "" };
  assert.deepEqual(sent.get("srv_panel"), [loopback, loopback]);
});

test("a server added by the panel's domain links through it, before and after the domain changes", async () => {
  // That name is the panel's, not proof of this machine: the domain can move.
  await seedServerRow(db, {
    id: "srv_named",
    ip: "panel.example.com",
    host: "panel.example.com",
  });
  const sent = linkingAgents();
  const old = { primary: "https://old.example.com", fallback: "" };
  await agentHelloSeen("srv_named", hello(old));
  process.env.DEPLO_PUBLIC_URL = "https://new.example.com";
  await agentHelloSeen("srv_named", hello(old));
  assert.deepEqual(sent.get("srv_named"), [
    { primary: PANEL, fallback: FALLBACK },
    { primary: "https://new.example.com", fallback: FALLBACK },
  ]);
});

test("a panel in a container with no link port on the host sends its own server the public pair", async (t) => {
  __setRunsInContainerForTest(true);
  t.after(() => __setRunsInContainerForTest());
  await seedServerRow(db, { id: "srv_panel", ip: HOST_IP, host: HOST_IP });
  const sent = linkingAgents();
  await agentHelloSeen(
    "srv_panel",
    hello({ primary: "http://127.0.0.1:3000", fallback: "" }),
  );
  assert.deepEqual(sent.get("srv_panel"), [
    { primary: PANEL, fallback: FALLBACK },
  ]);
});

test("with the fallback turned off an agent is sent a pair without one", async () => {
  await db.insert(instanceSettings).values({
    id: "default",
    panelFallbackDisabled: true,
    updatedAt: new Date().toISOString(),
  });
  const sent = linkingAgents();
  await agentHelloSeen(REMOTE, hello({ primary: PANEL, fallback: FALLBACK }));
  assert.deepEqual(sent.get(REMOTE), [{ primary: PANEL, fallback: "" }]);
});

test("nothing is sent while a Deplo move has the instance frozen", async (t) => {
  await db.insert(deploMoves).values({
    id: "dmv_target",
    side: "target",
    state: "copying",
    peerUrl: "https://old.example.com",
    startedBy: "user_1",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  invalidateFrozen();
  t.after(async () => {
    await pg.exec("delete from deplo_moves");
    invalidateFrozen();
  });
  const sent = linkingAgents();
  await agentHelloSeen(
    REMOTE,
    hello({ primary: "https://old.example.com", fallback: "" }),
  );
  assert.equal(sent.size, 0);
});

test("a panel that knows no address of its own sends none", async () => {
  delete process.env.DEPLO_PUBLIC_URL;
  const sent = linkingAgents();
  await agentHelloSeen(
    REMOTE,
    hello({ primary: "https://old.example.com", fallback: "" }),
  );
  assert.equal(sent.size, 0);
});

test("a server enrolled through a takeover's side door is moved to the panel's address once it is over", async () => {
  await db.insert(instanceSettings).values({
    id: "default",
    takeoverPlatform: "dokploy",
    takeoverState: "pending",
    updatedAt: new Date().toISOString(),
  });
  const sentDoor = { primary: "http://panel.example.com", fallback: "" };
  const sent = linkingAgents();
  await agentHelloSeen(REMOTE, hello(sentDoor));
  assert.equal(sent.size, 0, "until the cutover the side door is the way in");

  await db.update(instanceSettings).set({ takeoverState: "done" });
  await agentHelloSeen(REMOTE, hello(sentDoor));
  assert.deepEqual(sent.get(REMOTE), [{ primary: PANEL, fallback: FALLBACK }]);
});
