import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { instanceSettings } from "../db/schema/control-plane/instance";
import { activities } from "../db/schema/control-plane/activity";
import { runWithIdentity } from "../auth/request-context";
import {
  seedIdentity,
  TRUNCATE_IDENTITY,
  TEAM_A,
} from "./identity-test-helpers";
import { seedServerRow, TRUNCATE_INFRA } from "./infra-test-helpers";
import { panelRoute, withPanelRoute } from "../deploy/traefik-stack";
import { panelTunnelToken, TUNNEL_SERVICE } from "../deploy/panel-tunnel-stack";
import { __setAgentConnectorForTest } from "../infra/agent-client/connect";
import type { AgentConnection } from "../infra/agent-client/connection";
import {
  fakeCloudflare,
  type FakeCloudflare,
} from "../cloudflare/cloudflare-test-helpers";
import { forgetRoutedFallback } from "./instance-settings/panel-fallback";
import {
  __setPanelTunnelTimingForTest,
  disablePanelTunnel,
  getPanelTunnel,
  setPanelTunnel,
} from "./instance-settings/panel-tunnel";
import {
  getPanelHttps,
  setPanelHttps,
  setPanelUrl,
} from "./instance-settings/panel-route";
import {
  getInstanceSettings,
  rememberPanelUrl,
} from "./instance-settings/settings-store";
import type { PanelReachability } from "./instance-settings/panel-probe";

let db: TestDb;
let pg: PGlite;

const ADMIN = "admin1";
const MEMBER = "member2";
const HOST_IP = "203.0.113.10";
const FALLBACK = "deplo-cb00710a.deplo.site";
const API_TOKEN = "cf-api-token-0123456789";

const TRAEFIK_STACK = `services:
  traefik:
    image: traefik:v3.7
    container_name: deplo-traefik
    command:
      - --entrypoints.web.address=:80
      - --entrypoints.websecure.address=:443
      - --certificatesresolvers.letsencrypt.acme.email=ops@acme.com
networks:
  deplo:
    external: true
`;

const STACK = withPanelRoute(TRAEFIK_STACK, {
  domain: "old.example.com",
  fallbackDomain: FALLBACK,
  https: true,
  certResolver: "letsencrypt",
  target: "http://deplo:3000",
});

const asUser = <T>(userId: string, fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId, teamId: TEAM_A }, fn);

let host: { yaml: string; applied: number };
let cf: FakeCloudflare;
let restoreFetch = () => {};
let probes: string[];
let answers: (url: string) => PanelReachability;
const prevIp = process.env.DEPLO_SERVER_IP;

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
});

after(async () => {
  __resetTestDb();
  await pg.close();
  if (prevIp === undefined) delete process.env.DEPLO_SERVER_IP;
  else process.env.DEPLO_SERVER_IP = prevIp;
});

beforeEach(async () => {
  await pg.exec(TRUNCATE_IDENTITY);
  await pg.exec(TRUNCATE_INFRA);
  await pg.exec("truncate table activities restart identity cascade;");
  await pg.exec("delete from instance_settings;");
  await seedIdentity(db, {
    users: [
      { id: ADMIN, teamId: TEAM_A, role: "owner", isInstanceAdmin: true },
      { id: MEMBER, teamId: TEAM_A, role: "member", isInstanceAdmin: false },
    ],
  });
  process.env.DEPLO_SERVER_IP = HOST_IP;
  await seedServerRow(db, { id: "srv_panel", ip: HOST_IP, host: HOST_IP });
  forgetRoutedFallback();
  await rememberPanelUrl("https://old.example.com");

  host = { yaml: STACK, applied: 0 };
  __setAgentConnectorForTest(async () => {
    const conn = {
      hello: async () => ({ capabilities: ["hostops"] }),
      hostInfo: async () => ({ traefikComposeYaml: host.yaml }),
      traefikConfig: async (req: { composeYaml: string }) => {
        if (req.composeYaml) host.yaml = req.composeYaml;
        host.applied++;
        return { ok: true, error: "" };
      },
      close: () => {},
    };
    return conn as unknown as AgentConnection;
  });

  ({ cf, restore: restoreFetch } = fakeCloudflare());
  probes = [];
  answers = (url) => ({ url, ok: true, error: null });
  __setPanelTunnelTimingForTest({
    pollMs: 1,
    connectMs: 40,
    probeMs: 40,
    probe: async (url) => {
      probes.push(url);
      return answers(url);
    },
  });
});

afterEach(async () => {
  restoreFetch();
  __setAgentConnectorForTest();
  __setPanelTunnelTimingForTest();
  forgetRoutedFallback();
  await rememberPanelUrl(null);
});

const turnOn = (
  hostname = "deplo.example.com",
  apiToken: string | null = API_TOKEN,
) => asUser(ADMIN, () => setPanelTunnel({ hostname, apiToken }));

async function settingsRow() {
  const [row] = await db
    .select()
    .from(instanceSettings)
    .where(eq(instanceSettings.id, "default"));
  return row;
}

test("only an instance admin can read, set or turn off the tunnel", async () => {
  await assert.rejects(() => asUser(MEMBER, getPanelTunnel), /admin/i);
  await assert.rejects(
    () =>
      asUser(MEMBER, () =>
        setPanelTunnel({ hostname: "deplo.example.com", apiToken: API_TOKEN }),
      ),
    /admin/i,
  );
  await assert.rejects(
    () => asUser(MEMBER, () => disablePanelTunnel()),
    /admin/i,
  );
  assert.equal(cf.calls.length, 0, "nothing reached Cloudflare");
});

test("turning it on creates the tunnel, its routes and its record, and moves the panel", async () => {
  const tunnel = await turnOn();
  assert.equal(tunnel.enabled, true);
  assert.equal(tunnel.hostname, "deplo.example.com");
  assert.equal(tunnel.status, "healthy");

  const [id, made] = [...cf.tunnels.entries()][0];
  assert.equal(made.accountId, "acct1");
  assert.deepEqual(made.ingress, [
    {
      hostname: "deplo.example.com",
      path: "^/api/agent/link$",
      service: "http://deplo:3001",
    },
    { hostname: "deplo.example.com", service: "http://deplo:3000" },
    { service: "http_status:404" },
  ]);
  const record = [...cf.records.values()][0];
  assert.equal(record.name, "deplo.example.com");
  assert.equal(record.content, `${id}.cfargotunnel.com`);
  assert.equal(record.proxied, true);

  assert.equal(panelTunnelToken(host.yaml), `token-for-${id}`);
  assert.deepEqual(panelRoute(host.yaml), {
    domain: "deplo.example.com",
    fallbackDomain: FALLBACK,
    https: true,
    certResolver: null,
    target: "http://deplo:3000",
  });
  assert.deepEqual(probes, ["https://deplo.example.com"]);

  const settings = await asUser(ADMIN, getInstanceSettings);
  assert.equal(settings.panelUrl, "https://deplo.example.com");
  assert.equal(settings.panelTunnelHostname, "deplo.example.com");

  const row = await settingsRow();
  assert.ok(row.panelTunnelApiTokenEnc);
  assert.ok(
    !row.panelTunnelApiTokenEnc.includes(API_TOKEN),
    "the token is stored encrypted",
  );
  assert.ok(
    !JSON.stringify(tunnel).includes(API_TOKEN),
    "and never handed back",
  );

  const [entry] = await db
    .select({ message: activities.message })
    .from(activities);
  assert.match(
    entry.message,
    /Served the panel through a Cloudflare Tunnel at https:\/\/deplo\.example\.com/,
  );
});

test("while the tunnel serves the panel, its address and its HTTPS are the tunnel's", async () => {
  await turnOn();
  await assert.rejects(
    () => asUser(ADMIN, () => setPanelUrl("elsewhere.example.com")),
    /served through a Cloudflare Tunnel/,
  );
  await assert.rejects(
    () => asUser(ADMIN, () => setPanelHttps(false)),
    /Cloudflare serves/,
  );
  assert.match(
    (await asUser(ADMIN, getPanelHttps)).unavailable ?? "",
    /Cloudflare serves/,
  );
});

test("an address that does not answer through the tunnel undoes everything", async () => {
  answers = (url) => ({
    url,
    ok: false,
    error: `${url} answered 502, it does not reach Deplo yet`,
  });
  await assert.rejects(
    turnOn,
    /answered 502[\s\S]*still on https:\/\/old\.example\.com/,
  );

  assert.equal(host.yaml, STACK, "the proxy is back as it was");
  assert.equal(cf.tunnels.size, 0, "the tunnel is deleted");
  assert.equal(cf.records.size, 0, "and so is its record");
  const settings = await asUser(ADMIN, getInstanceSettings);
  assert.equal(settings.panelUrl, "https://old.example.com");
  assert.equal(settings.panelTunnelHostname, null);
});

test("a record made a moment ago that does not resolve here yet is not a failure", async () => {
  answers = (url) => ({
    url,
    ok: false,
    error: "ENOTFOUND",
    code: "ENOTFOUND",
  });
  assert.equal((await turnOn()).enabled, true);
});

test("a tunnel that never connects is undone", async () => {
  cf.connectedStatus = "inactive";
  await assert.rejects(turnOn, /did not connect to Cloudflare/);
  assert.equal(cf.tunnels.size, 0);
  assert.equal(panelTunnelToken(host.yaml), null);
});

test("a name somebody else's site uses is refused before anything is changed", async () => {
  cf.records.set("www", {
    id: "www",
    zoneId: "zone1",
    type: "A",
    name: "www.example.com",
    content: "198.51.100.7",
  });
  await assert.rejects(
    () => turnOn("www.example.com"),
    /already has a A record/,
  );
  assert.equal(cf.tunnels.size, 0);
  assert.deepEqual([...cf.records.keys()], ["www"]);
  assert.equal(host.applied, 0, "the proxy was never touched");
});

test("the panel's own record on its domain is taken over", async () => {
  cf.records.set("own", {
    id: "own",
    zoneId: "zone1",
    type: "A",
    name: "old.example.com",
    content: HOST_IP,
  });
  await turnOn("old.example.com");
  const [only] = [...cf.records.values()];
  assert.equal(only.type, "CNAME");
  assert.equal(only.name, "old.example.com");
});

test("a new address reuses the tunnel and drops the old record", async () => {
  await turnOn();
  const [id] = [...cf.tunnels.keys()];
  const moved = await turnOn("panel.example.com", null);
  assert.equal(moved.hostname, "panel.example.com");
  assert.deepEqual([...cf.tunnels.keys()], [id], "one tunnel, kept");
  assert.deepEqual(
    [...cf.records.values()].map((r) => r.name),
    ["panel.example.com"],
  );
  assert.equal(panelRoute(host.yaml)?.domain, "panel.example.com");
});

test("turning it off moves the panel to its backup address and deletes the tunnel", async () => {
  await turnOn();
  const off = await asUser(ADMIN, () => disablePanelTunnel());
  assert.equal(off.enabled, false);
  assert.equal(off.warning, null);

  assert.equal(panelTunnelToken(host.yaml), null);
  assert.ok(!host.yaml.includes(TUNNEL_SERVICE));
  const route = panelRoute(host.yaml)!;
  assert.equal(route.domain, FALLBACK);
  assert.equal(
    route.certResolver,
    "letsencrypt",
    "a name Deplo serves gets a certificate again",
  );
  assert.equal(cf.tunnels.size, 0);
  assert.equal(cf.records.size, 0);

  const settings = await asUser(ADMIN, getInstanceSettings);
  assert.equal(settings.panelUrl, `https://${FALLBACK}`);
  assert.equal(settings.panelTunnelHostname, null);
  assert.equal((await settingsRow()).panelTunnelApiTokenEnc, null);
});

test("an address that does not answer keeps the tunnel on", async () => {
  await turnOn();
  const before = host.yaml;
  answers = (url) => ({
    url,
    ok: false,
    error: `${url} did not answer (ECONNREFUSED)`,
  });
  await assert.rejects(
    () => asUser(ADMIN, () => disablePanelTunnel("deplo.lan.example.com")),
    /did not answer[\s\S]*still on https:\/\/deplo\.example\.com/,
  );
  assert.equal(host.yaml, before);
  assert.equal(cf.tunnels.size, 1);
  assert.equal(
    (await asUser(ADMIN, getInstanceSettings)).panelTunnelHostname,
    "deplo.example.com",
  );
});

test("what Cloudflare would not delete comes back as a warning, and the tunnel is still off", async () => {
  await turnOn();
  cf.failNext = {
    match: /^DELETE \/zones/,
    status: 403,
    message: "Authentication error",
  };
  const off = await asUser(ADMIN, () => disablePanelTunnel());
  assert.equal(off.enabled, false);
  assert.match(
    off.warning ?? "",
    /Cloudflare still has the old tunnel for deplo\.example\.com/,
  );
  const messages = (
    await db.select({ message: activities.message }).from(activities)
  ).map((a) => a.message);
  assert.ok(
    messages.some((m) =>
      /Turned off the panel's Cloudflare Tunnel[\s\S]*Cloudflare still has/.test(
        m,
      ),
    ),
  );
});

test("the tunnel's own name is not somewhere to move the panel off it", async () => {
  await turnOn();
  await assert.rejects(
    () => asUser(ADMIN, () => disablePanelTunnel("deplo.example.com")),
    /only reaches the panel through the tunnel/,
  );
});

test("a broken saved token still shows the tunnel, and says why its status is missing", async () => {
  await turnOn();
  cf.failNext = {
    match: /^GET \/accounts/,
    status: 403,
    message: "Invalid API Token",
  };
  const read = await asUser(ADMIN, getPanelTunnel);
  assert.equal(read.enabled, true);
  assert.equal(read.status, "unknown");
  assert.match(read.error ?? "", /refused the API token/);
});
