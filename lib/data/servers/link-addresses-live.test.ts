import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";

import { makeTestDb, type TestDb } from "../../db/test-harness";
import { __setTestDb, __resetTestDb } from "../../db/client";
import { runWithIdentity } from "../../auth/request-context";
import { seedServerRow, TRUNCATE_INFRA } from "../infra-test-helpers";
import { instanceSettings } from "../../db/schema/control-plane/instance";
import {
  seedIdentity,
  TEAM_A,
  TRUNCATE_IDENTITY,
  USER_1,
} from "../identity-test-helpers";
import { AGENT_VERSION } from "../../version";
import { withPanelRoute } from "../../deploy/traefik-stack";
import { setStoredPublicBaseUrl } from "../../public-url";
import { connectAgent } from "../../infra/agent-client/connect";
import { __setAgentConnectorForTest } from "../../infra/agent-client/connect";
import type { AgentConnection } from "../../infra/agent-client/connection";
import { dropAgentChannel } from "../../infra/agent-client/channel-pool";
import { AGENT_LINK_CAPABILITY } from "../../infra/agent-client/hello-capabilities";
import {
  eventually,
  startFakeAgent,
  type FakeAgent,
} from "../../infra/agent-client/fake-agent-test-helpers";
import {
  startAgentLinkListener,
  stopAgentLinkListener,
} from "../../infra/agent-link/listener";
import { forgetRoutedFallback } from "../instance-settings/panel-fallback";
import {
  setPanelFallback,
  setPanelHttps,
  setPanelUrl,
} from "../instance-settings/panel-route";
import { startLinkAddressSync, stopLinkAddressSync } from "./link-addresses";

// Real agents over a real door: what an agent is sent, and when.
const PANEL = "https://panel.example.com";
const HOST_IP = "203.0.113.10";
const FALLBACK = "https://deplo-cb00710a.deplo.site";
const SERVER = "srv_linked";
const OLD = { primary: "https://old.example.com", fallback: "" };

let db: TestDb;
let pg: PGlite;
let agent: FakeAgent;
let door: number;
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
  process.env.DEPLO_SERVER_IP = HOST_IP;
  await pg.exec(TRUNCATE_INFRA);
  await pg.exec(TRUNCATE_IDENTITY);
  await pg.exec("delete from instance_settings");
  await pg.exec("truncate table rate_limits");
  await seedIdentity(db);
  forgetRoutedFallback();
  agent = await startFakeAgent({
    capabilities: [AGENT_LINK_CAPABILITY],
    linkAddresses: OLD,
  });
  await seedServerRow(db, {
    id: SERVER,
    ip: "127.0.0.1",
    host: "127.0.0.1",
    agent: {
      port: agent.port,
      certFingerprint: agent.fingerprint,
      certPem: agent.certPem,
      version: AGENT_VERSION,
    },
  });
  startLinkAddressSync();
  door = (await startAgentLinkListener({ port: 0, host: "127.0.0.1" })).port;
});

afterEach(async () => {
  await stopLinkAddressSync();
  __setAgentConnectorForTest();
  await stopAgentLinkListener();
  dropAgentChannel(SERVER);
  await agent.stop();
  forgetRoutedFallback();
  setStoredPublicBaseUrl(null);
  for (const [k, v] of Object.entries(env))
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
});

const asAdmin = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);

const lastPair = () => agent.sentPairs().at(-1);

test("an agent whose link is verified with another pair is sent the panel's", async () => {
  await agent.link(door);
  await eventually(() => agent.sentPairs().length > 0);
  assert.deepEqual(agent.sentPairs(), [{ primary: PANEL, fallback: FALLBACK }]);
});

test("a server enrolled through a takeover's side door is sent the panel's pair when it links after the cutover", async (t) => {
  await db.insert(instanceSettings).values({
    id: "default",
    takeoverPlatform: "dokploy",
    takeoverState: "done",
    updatedAt: new Date().toISOString(),
  });
  // The cutover moved http to https; the agent follows that redirect to link again.
  const enrolled = await startFakeAgent({
    capabilities: [AGENT_LINK_CAPABILITY],
    linkAddresses: { primary: "http://panel.example.com", fallback: "" },
  });
  t.after(async () => {
    dropAgentChannel("srv_side_door");
    await enrolled.stop();
  });
  await seedServerRow(db, {
    id: "srv_side_door",
    ip: "198.51.100.7",
    host: "198.51.100.7",
    agent: {
      port: enrolled.port,
      certFingerprint: enrolled.fingerprint,
      certPem: enrolled.certPem,
      version: AGENT_VERSION,
    },
  });
  await enrolled.link(door);
  await eventually(() => enrolled.sentPairs().length > 0);
  assert.deepEqual(enrolled.sentPairs(), [
    { primary: PANEL, fallback: FALLBACK },
  ]);
  await eventually(() => !enrolled.listening());
});

test("changing the panel's address sends the new pair to a connected agent", async () => {
  await agent.link(door);
  await eventually(() => agent.sentPairs().length === 1);

  await asAdmin(() => setPanelUrl("https://moved.example.com"));
  await eventually(() => lastPair()?.primary === "https://moved.example.com");
  assert.deepEqual(lastPair(), {
    primary: "https://moved.example.com",
    fallback: FALLBACK,
  });
});

const PROXY = `services:
  traefik:
    image: traefik:v3.7
    container_name: deplo-traefik
    command:
      - --certificatesresolvers.letsencrypt.acme.email=ops@acme.com
`;

interface PanelProxy {
  yaml: string;
  /** The pair the linked agent held each time the proxy was rewritten, which drops its link. */
  heldWhenRewritten: (Pair | undefined)[];
  refuse: boolean;
}

type Pair = { primary: string; fallback: string };

/** The panel's own server answers with a proxy routing the panel; every other server is reached for real. */
async function panelHost(): Promise<PanelProxy> {
  await seedServerRow(db, { id: "srv_panel", ip: HOST_IP, host: HOST_IP });
  const proxy: PanelProxy = {
    yaml: withPanelRoute(PROXY, {
      domain: "panel.example.com",
      fallbackDomain: "deplo-cb00710a.deplo.site",
      https: true,
      certResolver: "letsencrypt",
      target: "http://deplo:3000",
    }),
    heldWhenRewritten: [],
    refuse: false,
  };
  __setAgentConnectorForTest(async (serverId) => {
    if (serverId !== "srv_panel") return null;
    const conn = {
      hello: async () => ({ capabilities: ["hostops"] }),
      hostInfo: async () => ({ traefikComposeYaml: proxy.yaml }),
      traefikConfig: async (req: { composeYaml: string }) => {
        proxy.heldWhenRewritten.push(lastPair());
        // The agent's link comes back while the proxy restarts: its Hello is seen mid-change.
        const again = await connectAgent(SERVER);
        await again.hello();
        again.close();
        if (proxy.refuse) return { ok: false, error: "the proxy refused it" };
        if (req.composeYaml) proxy.yaml = req.composeYaml;
        return { ok: true, error: "" };
      },
      close: () => {},
    };
    return conn as unknown as AgentConnection;
  });
  return proxy;
}

test("turning the fallback off sends a pair without it, and turning it on sends it back", async () => {
  const proxy = await panelHost();
  await agent.link(door);
  await eventually(() => agent.sentPairs().length === 1);

  await asAdmin(() => setPanelFallback(false));
  assert.deepEqual(
    proxy.heldWhenRewritten,
    [{ primary: PANEL, fallback: "" }],
    "the agent hears it before the proxy drops its link",
  );
  assert.deepEqual(agent.sentPairs(), [
    { primary: PANEL, fallback: FALLBACK },
    { primary: PANEL, fallback: "" },
  ]);

  await asAdmin(() => setPanelFallback(true));
  assert.deepEqual(lastPair(), { primary: PANEL, fallback: FALLBACK });
  assert.equal(agent.sentPairs().length, 3);
});

test("turning the panel's HTTPS off moves both addresses to plain http", async () => {
  const proxy = await panelHost();
  await agent.link(door);
  await eventually(() => agent.sentPairs().length === 1);

  await asAdmin(() => setPanelHttps(false));
  const plain = {
    primary: "http://panel.example.com",
    fallback: "http://deplo-cb00710a.deplo.site",
  };
  assert.deepEqual(proxy.heldWhenRewritten, [plain]);
  assert.deepEqual(lastPair(), plain);
});

test("a change the proxy refuses puts the agent back on the pair the panel kept", async () => {
  const proxy = await panelHost();
  await agent.link(door);
  await eventually(() => agent.sentPairs().length === 1);

  proxy.refuse = true;
  await assert.rejects(() => asAdmin(() => setPanelFallback(false)));
  assert.deepEqual(proxy.heldWhenRewritten, [{ primary: PANEL, fallback: "" }]);
  assert.deepEqual(lastPair(), { primary: PANEL, fallback: FALLBACK });
});
