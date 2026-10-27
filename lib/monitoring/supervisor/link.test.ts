import { test, beforeEach, afterEach, mock, type TestContext } from "node:test";
import assert from "node:assert/strict";

import { seedServerRow } from "../../data/infra-test-helpers";
import { getServerById } from "../../data/servers/roster";
import {
  startServerLinkStatus,
  stopServerLinkStatus,
} from "../../data/server-health";
import {
  startLinkAddressSync,
  stopLinkAddressSync,
} from "../../data/servers/link-addresses";
import {
  dropAgentChannel,
  onAgentHello,
} from "../../infra/agent-client/channel-pool";
import { openAgent } from "../../infra/agent-client/connect";
import {
  startFakeAgent,
  type FakeAgent,
  type FakeLink,
} from "../../infra/agent-client/fake-agent-test-helpers";
import { AgentUnreachableError } from "../../infra/agent-client/errors";
import {
  AGENT_LINK_CAPABILITY,
  METRICS_STREAM_CAPABILITY,
} from "../../infra/agent-client/hello-capabilities";
import {
  startAgentLinkListener,
  stopAgentLinkListener,
} from "../../infra/agent-link/listener";
import { LINK_SETTLE_MS } from "../../infra/agent-link/protocol";
import { onAgentLink } from "../../infra/agent-link/registry";
import { HEALTH_MESSAGES } from "../../infra/server-health";
import { AGENT_VERSION } from "../../version";
import { getMetricsHistory } from "../history";
import {
  __setMetricsConnectorForTest,
  startMetricsStreams,
} from "../supervisor";
import { frame, setupSupervisor, waitFor } from "./supervisor-test-helpers";

const SERVER = "srv_linked";

let agent: FakeAgent;
let door: number;

// Before the supervisor's own teardown: closing the door ends any wait for a link it is in.
afterEach(async () => {
  stopServerLinkStatus();
  await stopAgentLinkListener();
  dropAgentChannel(SERVER);
  await agent.stop();
});

const h = setupSupervisor();

beforeEach(async () => {
  agent = await startFakeAgent({ capabilities: [METRICS_STREAM_CAPABILITY] });
  await seedServerRow(h.db, {
    id: SERVER,
    ip: "127.0.0.1",
    host: "127.0.0.1",
    status: "online",
    agent: {
      port: agent.port,
      certFingerprint: agent.fingerprint,
      certPem: agent.certPem,
      version: AGENT_VERSION,
    },
  });
  door = (await startAgentLinkListener({ port: 0, host: "127.0.0.1" })).port;
});

function linkEvent(type: "up" | "down"): Promise<void> {
  return new Promise((resolve) => {
    const off = onAgentLink((e) => {
      if (e.serverId !== SERVER || e.type !== type) return;
      off();
      resolve();
    });
  });
}

async function linkIn(): Promise<FakeLink> {
  const up = linkEvent("up");
  const link = await agent.link(door);
  await up;
  return link;
}

// Until the stream has reached the agent, a frame goes nowhere.
async function streamed(frames: number): Promise<void> {
  await waitFor(() => {
    agent.sample(frame());
    return getMetricsHistory(SERVER).length >= frames;
  }, `${frames} frame(s) recorded`);
}

async function shown(serverId = SERVER) {
  const s = (await getServerById(serverId))!;
  return {
    status: s.status,
    message: s.statusMessage ?? null,
    checkedAt: s.statusCheckedAt ?? null,
  };
}

/** Every status the server shows until `stop`. */
function watchStatus(serverId = SERVER): {
  seen: string[];
  stop: () => Promise<void>;
} {
  const seen: string[] = [];
  let on = true;
  const loop = (async () => {
    while (on) {
      seen.push((await shown(serverId)).status);
      await new Promise((r) => setTimeout(r, 20));
    }
  })();
  return {
    seen,
    stop: async () => {
      on = false;
      await loop;
    },
  };
}

test("a linked server's telemetry streams over its link", async () => {
  await linkIn();
  startMetricsStreams();

  await streamed(1);
  assert.equal(agent.connections().opened, 0, "nothing dialed the agent");
});

test("a server that never linked is asked once, then its telemetry waits for its link instead of dialing again", async (t) => {
  let hellos = 0;
  t.after(onAgentHello((id) => void (id === SERVER && hellos++)));
  const watching = watchStatus();
  t.after(watching.stop);
  startMetricsStreams();
  await waitFor(() => hellos >= 1, "the stream asked the server");
  await new Promise((r) => setTimeout(r, 2_500));
  assert.equal(hellos, 1, "asked again over its dial");
  assert.equal(agent.connections().opened, 1);

  await linkIn();
  await streamed(1);
  await watching.stop();
  assert.ok(!watching.seen.includes("offline"), watching.seen.join(","));
});

test("a link that drops and comes back never shows the server offline, and its telemetry and health resume", async () => {
  const link = await linkIn();
  startMetricsStreams();
  await streamed(1);
  const watching = watchStatus();

  const down = linkEvent("down");
  link.drop();
  await down;
  const dropped = new Date().toISOString();
  await new Promise((r) => setTimeout(r, 300));
  await linkIn();
  await streamed(getMetricsHistory(SERVER).length + 1);
  await watching.stop();

  assert.ok(!watching.seen.includes("offline"), watching.seen.join(","));
  const now = await shown();
  assert.equal(now.status, "online");
  assert.ok(now.checkedAt! > dropped, "the stream observed it again");
  assert.equal(agent.connections().opened, 0, "nothing dialed the agent");
});

test("a link that stays away shows the server offline with the link's own words", async () => {
  startServerLinkStatus({ graceMs: 300 });
  const link = await linkIn();
  startMetricsStreams();
  await streamed(1);

  link.drop();
  await waitFor(
    async () => (await shown()).status === "offline",
    "the server shows offline",
  );
  // The stream's reconnects keep failing meanwhile; none of them rewrites why.
  await new Promise((r) => setTimeout(r, 1_500));
  const now = await shown();
  assert.equal(now.status, "offline");
  assert.equal(now.message, HEALTH_MESSAGES.offline);
});

test("right after the panel starts, a server whose stream finds its port closed is not shown offline until links settle", async (t) => {
  let dials = 0;
  // It stopped listening once it linked, and has not relinked since the panel restarted.
  __setMetricsConnectorForTest(async () => {
    dials++;
    throw new AgentUnreachableError("connect ECONNREFUSED 127.0.0.1:9443", 14);
  });
  const before = await shown();
  startMetricsStreams();
  await waitFor(() => dials >= 1, "the stream tried the server");
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(await shown(), before);

  mock.timers.enable({ apis: ["Date"], now: Date.now() + LINK_SETTLE_MS });
  t.after(() => mock.timers.reset());
  await waitFor(
    async () => (await shown()).status === "offline",
    "offline once the panel has settled",
  );
  assert.equal((await shown()).message, HEALTH_MESSAGES.offline);
});

const CUT_OFF = "srv_cut_off";

function withEnv(t: TestContext, vars: Record<string, string>): void {
  for (const [k, v] of Object.entries(vars)) {
    const was = process.env[k];
    process.env[k] = v;
    t.after(() => {
      if (was === undefined) delete process.env[k];
      else process.env[k] = was;
    });
  }
}

test("a server that answers its dial but never links gets the probe's warning from its telemetry's Hello, never online", async (t) => {
  withEnv(t, {
    DEPLO_PUBLIC_URL: "https://panel.example.com",
    DEPLO_SERVER_IP: "203.0.113.10",
  });
  const cut = await startFakeAgent({
    capabilities: [METRICS_STREAM_CAPABILITY, AGENT_LINK_CAPABILITY],
    linkAddresses: { primary: "", fallback: "" },
  });
  t.after(async () => {
    dropAgentChannel(CUT_OFF);
    await cut.stop();
  });
  await seedServerRow(h.db, {
    id: CUT_OFF,
    ip: "127.0.0.1",
    host: "127.0.0.1",
    status: "offline",
    agent: {
      port: cut.port,
      certFingerprint: cut.fingerprint,
      certPem: cut.certPem,
      version: AGENT_VERSION,
    },
  });
  startLinkAddressSync();
  const conn = await openAgent(CUT_OFF);
  await conn.hello().finally(() => conn.close());
  await waitFor(() => cut.sentPairs().length > 0, "handed the address");
  await stopLinkAddressSync();
  mock.timers.enable({ apis: ["Date"], now: Date.now() + LINK_SETTLE_MS });
  t.after(() => mock.timers.reset());

  const watching = watchStatus(CUT_OFF);
  t.after(watching.stop);
  startMetricsStreams();
  await waitFor(
    async () => (await shown(CUT_OFF)).status === "warning",
    "the server shows warning",
  );
  await new Promise((r) => setTimeout(r, 1_000));
  await watching.stop();
  assert.equal(
    (await shown(CUT_OFF)).message,
    "This server can't reach Deplo at panel.example.com. Check that it's connected to the internet.",
  );
  assert.ok(!watching.seen.includes("online"), watching.seen.join(","));
});
