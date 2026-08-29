process.env.DEPLO_PUBLIC_URL = "https://deplo.test";

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import {
  PROTOCOL_VERSION_META_KEY,
  CLIENT_CAPABILITIES_META_KEY,
} from "@modelcontextprotocol/server";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import {
  seedIdentity,
  TEAM_A,
  TEAM_B,
  USER_1,
} from "../data/identity-test-helpers";
import {
  seedApp,
  seedServer,
  TRUNCATE_PROJECT_GRAPH,
} from "../data/app-graph-test-helpers";
import {
  __setDnsResolve4ForTest,
  __resetDnsResolve4ForTest,
} from "../data/domains";
import {
  __setAgentConnectorForTest,
  type AgentConnection,
} from "../infra/agent-client";
import { runWithIdentity } from "../auth/request-context";
import { createToken } from "../data/tokens";
import { POST } from "@/app/api/mcp/route";
import type { Capability } from "../types";

/**
 * Working a MULTI-CONTAINER app over MCP, driven at the real `/api/mcp` route:
 * routing, scheduling and reading logs all have to name WHICH container, or the
 * model cannot do what the dashboard does. Ends at the YAML the agent receives.
 */

let db: TestDb;
let pg: PGlite;

const RESOURCE = "https://deplo.test/api/mcp";
const SERVER_IP = "10.0.0.1";
/** A five-container analytics stack: three backing services, two web faces. */
const STACK = `services:
  clickhouse:
    image: clickhouse/clickhouse-server:24.3
  postgres:
    image: postgres:16
  redis:
    image: redis:7
  backend:
    image: example.io/backend:1
    ports:
      - "3001:3001"
  client:
    image: example.io/client:1
    ports:
      - "3002:3002"
`;

/** The stack's containers, as the owning agent lists them. */
const CONTAINERS = ["backend", "clickhouse", "client", "postgres", "redis"].map(
  (service) => ({
    name: `deplo-analytics-${service}-1`,
    service,
    image: `example.io/${service}:1`,
    running: true,
    exposed: service === "client",
    user: "root",
    workdir: "/",
    openStdin: false,
    tty: false,
    state: "running",
    health: "",
    restartCount: 0,
    startedAtUnix: 0,
  }),
);

/** The last stack the agent was asked to write, per slug. */
let rerouted = new Map<string, string>();

const TRUNCATE = `truncate table
  api_tokens, membership_capabilities, memberships, users, teams
  restart identity cascade;`;

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
  // The operator pointed DNS at the host before adding the domain - what the
  // manual tells them to do, and what makes the row born `valid` and routable.
  __setDnsResolve4ForTest(async () => [SERVER_IP]);
  __setAgentConnectorForTest(agentStub);
});

/** A stand-in for the owning server's agent: records what it is asked to write. */
async function agentStub(): Promise<AgentConnection> {
  const conn: Partial<AgentConnection> = {
    readStack: async () => ({ exists: true, yaml: "# an older render\n" }),
    reroute: async (req) => {
      rerouted.set(req.slug, req.composeYaml);
      return { ok: true, error: "" };
    },
    listInstances: async () => CONTAINERS,
    followLogs: (_projectId: string, container: string) => ({
      onData: (cb: (chunk: Buffer) => void) => {
        setTimeout(() => cb(Buffer.from(`log line from ${container}\n`)), 1);
        return () => {};
      },
      onExit: () => {},
      write: () => {},
      close: () => {},
    }),
    close: () => {},
  };
  return conn as unknown as AgentConnection;
}

after(async () => {
  __resetDnsResolve4ForTest();
  __setAgentConnectorForTest();
  __resetTestDb();
  await pg.close();
});

beforeEach(async () => {
  await pg.exec(`${TRUNCATE_PROJECT_GRAPH} ${TRUNCATE}`);
  await seedIdentity(db);
  await seedServer(db);
  rerouted = new Map();
  await seedApp(db, {
    id: "prj_analytics",
    slug: "analytics",
    source: "compose",
    compose: STACK,
  });
});

/** One JSON-RPC call at the route, exactly as an MCP client makes it. */
async function rpc(
  bearer: string,
  method: string,
  params: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${bearer}`,
    "mcp-method": method,
  };
  if (typeof params.name === "string") headers["mcp-name"] = params.name;
  const res = await POST(
    new Request(RESOURCE, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        params: {
          ...params,
          _meta: {
            [PROTOCOL_VERSION_META_KEY]: "2026-07-28",
            [CLIENT_CAPABILITIES_META_KEY]: {},
          },
        },
      }),
    }),
  );
  const text = await res.text();
  const payload = text.startsWith("data:")
    ? text.slice(text.indexOf("data:") + 5).split("\n")[0]
    : text;
  return JSON.parse(payload) as Record<string, unknown>;
}

interface ToolResult {
  isError?: boolean;
  content?: { type: string; text?: string }[];
}

/** Call one tool; return the model-visible text and whether it was an error. */
async function callTool(
  bearer: string,
  name: string,
  args: Record<string, unknown>,
): Promise<{ error: boolean; text: string }> {
  const body = await rpc(bearer, "tools/call", { name, arguments: args });
  assert.ok(!body.error, `JSON-RPC error: ${JSON.stringify(body.error)}`);
  const result = body.result as ToolResult;
  const text = result.content?.find((c) => c.type === "text")?.text ?? "";
  return { error: result.isError === true, text };
}

function json(text: string): Record<string, unknown> {
  return JSON.parse(text) as Record<string, unknown>;
}

function mintToken(
  capabilities: Capability[] = ["view", "manage_domains"],
): Promise<{ raw: string }> {
  return runWithIdentity({ userId: USER_1, teamId: TEAM_A }, () =>
    createToken({ name: "agent", capabilities, teamIds: [TEAM_A] }),
  );
}

async function domainRows(): Promise<
  { name: string; service: string | null }[]
> {
  const rows = await pg.query<{ name: string; service: string | null }>(
    `select name, service from domains order by name`,
  );
  return rows.rows;
}

/** Every Traefik label in the rendered stack, per compose service. */
function labelsFor(yamlText: string, service: string): string[] {
  const lines = yamlText.split("\n");
  const start = lines.findIndex((l) => l.trim() === `${service}:`);
  assert.ok(start >= 0, `service ${service} missing from the rendered stack`);
  const indent = lines[start].indexOf(service);
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const bare = line.trim();
    if (bare && line.search(/\S/) <= indent) break;
    if (bare.startsWith("- ") && bare.includes("traefik."))
      out.push(bare.slice(2));
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * The wall the operator hit: the tool must ADVERTISE the container
 * ------------------------------------------------------------------ */

test("add_domain advertises the container it routes to", async () => {
  const { raw } = await mintToken();
  const body = await rpc(raw, "tools/list");
  const tools = (
    body.result as { tools: { name: string; inputSchema: unknown }[] }
  ).tools;
  const add = tools.find((t) => t.name === "add_domain");
  assert.ok(add, "add_domain must be listed for a manage_domains token");
  const props = (add.inputSchema as { properties?: Record<string, unknown> })
    .properties;
  assert.ok(
    props?.service,
    `add_domain takes no container argument: ${Object.keys(props ?? {}).join(", ")}`,
  );
  // Discoverable without guessing: the description has to point at where the
  // names come from, or a model tries the port, then the service name, then a
  // combination of both - which is exactly what happened.
  assert.match(JSON.stringify(add), /get_app/);
});

/* ------------------------------------------------------------------ *
 * Adding one, and what the host actually receives
 * ------------------------------------------------------------------ */

test("a domain named onto a container routes to that container", async () => {
  const { raw } = await mintToken();
  const res = await callTool(raw, "add_domain", {
    appId: "prj_analytics",
    name: "app.acme.com",
    service: "client",
    port: 3002,
    certProvider: "letsencrypt",
  });
  assert.equal(res.error, false, res.text);

  const domain = (json(res.text).addDomain ?? {}) as Record<string, unknown>;
  assert.equal(domain.service, "client");
  assert.equal(domain.port, 3002);
  assert.equal(domain.status, "valid");
  assert.equal(domain.primary, true, "the first domain becomes primary");

  // And the router really landed on `client`, not on some default container.
  const stack = rerouted.get("analytics");
  assert.ok(stack, "the agent was never asked to re-apply routing");
  const client = labelsFor(stack!, "client");
  assert.ok(
    client.some((l) => l.includes("Host(`app.acme.com`)")),
    `no router for the host on client: ${client.join(" | ")}`,
  );
  assert.ok(client.some((l) => /loadbalancer\.server\.port=3002$/.test(l)));
  for (const other of ["backend", "clickhouse", "postgres", "redis"])
    assert.ok(
      !labelsFor(stack!, other).some((l) => l.includes("app.acme.com")),
      `${other} must not answer for the host`,
    );
});

test("two domains reach two different containers of the same app", async () => {
  const { raw } = await mintToken();
  const one = await callTool(raw, "add_domain", {
    appId: "prj_analytics",
    name: "app.acme.com",
    service: "client",
    port: 3002,
  });
  assert.equal(one.error, false, one.text);
  const two = await callTool(raw, "add_domain", {
    appId: "prj_analytics",
    name: "api.acme.com",
    service: "backend",
    port: 3001,
  });
  assert.equal(two.error, false, two.text);

  const stack = rerouted.get("analytics")!;
  const client = labelsFor(stack, "client");
  const backend = labelsFor(stack, "backend");
  assert.ok(client.some((l) => l.includes("Host(`app.acme.com`)")));
  assert.ok(backend.some((l) => l.includes("Host(`api.acme.com`)")));
  assert.ok(!client.some((l) => l.includes("api.acme.com")));
  assert.ok(!backend.some((l) => l.includes("app.acme.com")));
  // The second add must not have unrouted the first.
  assert.ok(client.some((l) => /loadbalancer\.server\.port=3002$/.test(l)));
  assert.ok(backend.some((l) => /loadbalancer\.server\.port=3001$/.test(l)));
});

test("list_domains reports the container, so the agent can check its own work", async () => {
  const { raw } = await mintToken();
  await callTool(raw, "add_domain", {
    appId: "prj_analytics",
    name: "app.acme.com",
    service: "client",
    port: 3002,
  });
  const res = await callTool(raw, "list_domains", { appId: "prj_analytics" });
  assert.equal(res.error, false, res.text);
  const rows = (json(res.text).domains ?? []) as Record<string, unknown>[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].service, "client");
});

/* ------------------------------------------------------------------ *
 * Refusals: every one has to be actionable, and leave no half row
 * ------------------------------------------------------------------ */

test("a multi-container app refuses a domain that names no container", async () => {
  const { raw } = await mintToken();
  const res = await callTool(raw, "add_domain", {
    appId: "prj_analytics",
    name: "app.acme.com",
    port: 3002,
  });
  assert.equal(res.error, true, "a container-less add must be refused");
  assert.match(res.text, /container this domain routes to/);
  assert.deepEqual(await domainRows(), [], "a refused add must leave no row");
});

test("a multi-container app refuses a domain with no port", async () => {
  const { raw } = await mintToken();
  const res = await callTool(raw, "add_domain", {
    appId: "prj_analytics",
    name: "app.acme.com",
    service: "client",
  });
  assert.equal(res.error, true);
  assert.match(res.text, /port is required/i);
  assert.deepEqual(await domainRows(), []);
});

test("a container that is not in the compose file is refused by name", async () => {
  const { raw } = await mintToken();
  const res = await callTool(raw, "add_domain", {
    appId: "prj_analytics",
    name: "app.acme.com",
    service: "frontend",
    port: 3002,
  });
  assert.equal(res.error, true);
  assert.match(res.text, /No container named "frontend"/);
  assert.deepEqual(await domainRows(), []);
});

test("a single-image app refuses a container argument instead of ignoring it", async () => {
  const { raw } = await mintToken();
  await seedApp(db, { id: "prj_single", slug: "single", source: "github" });
  const res = await callTool(raw, "add_domain", {
    appId: "prj_single",
    name: "solo.acme.com",
    service: "web",
    port: 3000,
  });
  assert.equal(res.error, true);
  assert.match(res.text, /only available for compose stacks/);
  assert.deepEqual(await domainRows(), []);
});

test("a container named after deplo's own infrastructure is refused", async () => {
  // `postgres`, `traefik` and `deplo` are the names the platform answers to on
  // the shared network. A domain pointed at one used to be stored, and every
  // later render of that stack - reroute AND deploy - threw on it.
  const { raw } = await mintToken();
  const res = await callTool(raw, "add_domain", {
    appId: "prj_analytics",
    name: "db.acme.com",
    service: "postgres",
    port: 5432,
  });
  assert.equal(res.error, true, "a reserved container must be refused");
  assert.match(res.text, /Rename the service/);
  assert.deepEqual(
    await domainRows(),
    [],
    "the app must stay renderable: no row, no bricked deploy",
  );
});

test("an app in another team is not found, whatever the container", async () => {
  const { raw } = await mintToken();
  await seedApp(db, {
    id: "prj_other",
    teamId: TEAM_B,
    slug: "other",
    source: "compose",
    compose: STACK,
  });
  const res = await callTool(raw, "add_domain", {
    appId: "prj_other",
    name: "steal.acme.com",
    service: "client",
    port: 3002,
  });
  assert.equal(res.error, true);
  assert.match(res.text, /not found|isn't allowed|not allowed/i);
  assert.deepEqual(await domainRows(), []);
});

test("a token without manage_domains cannot add one", async () => {
  const { raw } = await mintToken(["view"]);
  const listed = await rpc(raw, "tools/list");
  const names = (listed.result as { tools: { name: string }[] }).tools.map(
    (t) => t.name,
  );
  assert.ok(!names.includes("add_domain"), "add_domain must be hidden");
  // And hidden is not the gate: calling it by name anyway is refused.
  const body = await rpc(raw, "tools/call", {
    name: "add_domain",
    arguments: {
      appId: "prj_analytics",
      name: "app.acme.com",
      service: "client",
      port: 3002,
    },
  });
  assert.ok(
    body.error,
    `add_domain ran for a view-only token: ${JSON.stringify(body)}`,
  );
  assert.deepEqual(await domainRows(), []);
});

/* ------------------------------------------------------------------ *
 * The rest of the domain surface, from an agent's seat
 * ------------------------------------------------------------------ */

test("removing a domain re-applies routing without it", async () => {
  const { raw } = await mintToken();
  const added = await callTool(raw, "add_domain", {
    appId: "prj_analytics",
    name: "app.acme.com",
    service: "client",
    port: 3002,
  });
  const id = (json(added.text).addDomain as { id: string }).id;
  const res = await callTool(raw, "remove_domain", { id });
  assert.equal(res.error, false, res.text);
  const stack = rerouted.get("analytics")!;
  assert.ok(
    !stack.includes("app.acme.com"),
    "the removed host still appears in the stack sent to the agent",
  );
});

test("a second app cannot take a hostname this team already serves", async () => {
  const { raw } = await mintToken();
  await callTool(raw, "add_domain", {
    appId: "prj_analytics",
    name: "app.acme.com",
    service: "client",
    port: 3002,
  });
  await seedApp(db, {
    id: "prj_second",
    slug: "second",
    source: "compose",
    compose: STACK,
  });
  const res = await callTool(raw, "add_domain", {
    appId: "prj_second",
    name: "app.acme.com",
    service: "client",
    port: 3002,
  });
  assert.equal(res.error, true);
  assert.match(res.text, /already added/i);
});

test("an argument the tool does not take is refused, not silently dropped", async () => {
  // What a model does when a parameter is missing: invent a plausible one. A
  // silent drop is how "I set the container" and "no container was set" end up
  // being the same call.
  const { raw } = await mintToken();
  const res = await callTool(raw, "add_domain", {
    appId: "prj_analytics",
    name: "app.acme.com",
    container: "client",
    port: 3002,
  });
  assert.equal(res.error, true, res.text);
  // Refused for the ARGUMENT, not for the missing container: a silent drop would
  // fail with "select the container" and read as the model's own mistake.
  assert.match(res.text, /container/i, "the refusal must name the bad key");
  assert.doesNotMatch(res.text, /Select the container this domain routes to/);
  assert.deepEqual(await domainRows(), []);
});

/* ------------------------------------------------------------------ *
 * Correcting a mistake, and the one-hostname-two-containers shape
 * ------------------------------------------------------------------ */

test("a domain can be moved onto another container without being deleted", async () => {
  const { raw } = await mintToken();
  const added = await callTool(raw, "add_domain", {
    appId: "prj_analytics",
    name: "app.acme.com",
    service: "client",
    port: 3002,
  });
  const id = (json(added.text).addDomain as { id: string }).id;

  const res = await callTool(raw, "update_domain", {
    id,
    service: "backend",
    port: 3001,
  });
  assert.equal(res.error, false, res.text);
  const after = json(res.text).updateDomain as Record<string, unknown>;
  assert.equal(after.service, "backend");
  assert.equal(after.port, 3001);

  const stack = rerouted.get("analytics")!;
  assert.ok(
    labelsFor(stack, "backend").some((l) => l.includes("Host(`app.acme.com`)")),
  );
  assert.ok(
    !labelsFor(stack, "client").some((l) => l.includes("app.acme.com")),
    "the old container still answers for the host",
  );
});

test("a domain cannot be moved onto deplo's own network names either", async () => {
  const { raw } = await mintToken();
  const added = await callTool(raw, "add_domain", {
    appId: "prj_analytics",
    name: "app.acme.com",
    service: "client",
    port: 3002,
  });
  const id = (json(added.text).addDomain as { id: string }).id;
  const res = await callTool(raw, "update_domain", { id, service: "postgres" });
  assert.equal(res.error, true, "the update path needs the same refusal");
  assert.match(res.text, /Rename the service/);
  assert.deepEqual(
    (await domainRows())[0],
    { name: "app.acme.com", service: "client" },
    "a refused edit must leave the working route alone",
  );
});

test("one hostname can serve two containers on different paths", async () => {
  const { raw } = await mintToken();
  const site = await callTool(raw, "add_domain", {
    appId: "prj_analytics",
    name: "acme.com",
    service: "client",
    port: 3002,
  });
  assert.equal(site.error, false, site.text);
  const api = await callTool(raw, "add_domain", {
    appId: "prj_analytics",
    name: "acme.com",
    service: "backend",
    port: 3001,
    pathPrefix: "/api",
    stripPrefix: true,
  });
  assert.equal(api.error, false, api.text);
  assert.equal(
    (json(api.text).addDomain as { pathPrefix?: string }).pathPrefix,
    "/api",
  );

  const stack = rerouted.get("analytics")!;
  const backend = labelsFor(stack, "backend");
  assert.ok(backend.some((l) => l.includes("PathPrefix(`/api`)")));
  assert.ok(backend.some((l) => l.includes("stripprefix.prefixes=/api")));
  assert.ok(
    labelsFor(stack, "client").some((l) => l.includes("Host(`acme.com`)")),
  );
  // Both rows are told apart in what the model reads back.
  const listed = await callTool(raw, "list_domains", {
    appId: "prj_analytics",
  });
  const paths = (
    json(listed.text).domains as { pathPrefix: string | null }[]
  ).map((d) => d.pathPrefix);
  assert.equal(paths.length, 2);
  assert.ok(paths.includes(null) && paths.includes("/api"));
});

/* ------------------------------------------------------------------ *
 * The same question for a scheduled command: WHICH container
 * ------------------------------------------------------------------ */

test("a cron job can name the container it runs in", async () => {
  const { raw } = await mintToken(["view", "manage_domains", "manage_crons"]);
  const res = await callTool(raw, "create_cron_job", {
    appId: "prj_analytics",
    name: "nightly rollup",
    command: "npm run rollup",
    schedule: "0 3 * * *",
    service: "backend",
  });
  assert.equal(res.error, false, res.text);
  assert.equal(
    (json(res.text).createCronJob as { service?: string }).service,
    "backend",
    "without this the job lands in whatever container is up first",
  );
});

test("a cron job cannot name a container the stack does not have", async () => {
  const { raw } = await mintToken(["view", "manage_domains", "manage_crons"]);
  const res = await callTool(raw, "create_cron_job", {
    appId: "prj_analytics",
    name: "nightly rollup",
    command: "npm run rollup",
    schedule: "0 3 * * *",
    service: "worker",
  });
  assert.equal(res.error, true, "a stored typo only shows up at 3am");
  assert.match(res.text, /No container named "worker"/);
});

/* ------------------------------------------------------------------ *
 * Reading ONE container's logs, named the only way an agent knows it
 * ------------------------------------------------------------------ */

test("logs can be asked for by compose service name", async () => {
  const { raw } = await mintToken(["view", "view_logs"]);
  const res = await callTool(raw, "app_logs", {
    appId: "prj_analytics",
    container: "backend",
    lines: 50,
  });
  assert.equal(res.error, false, res.text);
  const snapshot = json(res.text) as { container: string; text: string };
  assert.equal(snapshot.container, "deplo-analytics-backend-1");
  assert.match(snapshot.text, /log line from deplo-analytics-backend-1/);
});

test("logs still take the container's own name, as the dashboard sends it", async () => {
  const { raw } = await mintToken(["view", "view_logs"]);
  const res = await callTool(raw, "app_logs", {
    appId: "prj_analytics",
    container: "deplo-analytics-client-1",
  });
  assert.equal(res.error, false, res.text);
  assert.equal(
    (json(res.text) as { container: string }).container,
    "deplo-analytics-client-1",
  );
});

test("a container that is not in the stack says so", async () => {
  const { raw } = await mintToken(["view", "view_logs"]);
  const res = await callTool(raw, "app_logs", {
    appId: "prj_analytics",
    container: "worker",
  });
  assert.equal(res.error, true);
});

test("a host that cannot be reached is reported as saved-but-not-applied", async () => {
  // The row is committed before the agent is dialled. Told only "unreachable",
  // an agent retries and collects "Domain already added" instead.
  __setAgentConnectorForTest(async () => {
    throw new Error("agent unreachable");
  });
  try {
    const { raw } = await mintToken();
    const res = await callTool(raw, "add_domain", {
      appId: "prj_analytics",
      name: "app.acme.com",
      service: "client",
      port: 3002,
    });
    assert.equal(res.error, true);
    assert.match(res.text, /saved, but the routing could not be applied/i);
    assert.match(res.text, /agent unreachable/);
    assert.equal((await domainRows()).length, 1, "the row is there either way");
  } finally {
    __setAgentConnectorForTest(agentStub);
  }
});

test("render_compose shows the agent the routing it just wrote", async () => {
  const { raw } = await mintToken(["view", "manage_domains"]);
  await callTool(raw, "add_domain", {
    appId: "prj_analytics",
    name: "app.acme.com",
    service: "client",
    port: 3002,
  });
  const res = await callTool(raw, "render_compose", { appId: "prj_analytics" });
  assert.equal(res.error, false, res.text);
  const yamlText = String(json(res.text).renderComposeStack ?? "");
  assert.ok(
    labelsFor(yamlText, "client").some((l) =>
      l.includes("Host(`app.acme.com`)"),
    ),
    "the agent's own verification step must show the router",
  );
});
