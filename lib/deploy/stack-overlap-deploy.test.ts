import { test, before, after, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";
import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import yaml from "../yaml";
import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { __setAgentConnectorForTest } from "../infra/agent-client/connect";
import type { AgentConnection } from "../infra/agent-client/connection";
import { STACK_OVERLAP_CAPABILITY } from "../infra/agent-client/hello-capabilities";
import { seedIdentity, TEAM_A, USER_1 } from "../data/identity-test-helpers";
import {
  seedApp,
  seedDeployment,
  seedServer,
  TRUNCATE_PROJECT_GRAPH,
} from "../data/app-graph-test-helpers";
import { apps } from "../db/schema/control-plane/apps";
import {
  appTunnelDomains,
  appTunnels,
  dnsProviders,
} from "../db/schema/control-plane/dns-providers";
import { encryptSecret } from "../crypto";
import { appConnectorService } from "./app-connector";
import { deploymentLogs } from "../db/schema/control-plane/deployments";
import { domains } from "../db/schema/control-plane/domains";
import { servers } from "../db/schema/control-plane/servers";
import { ContractVersion, type DeployRequest } from "../agent/gen/agent";
import { runDeploymentGuarded } from "./build/deploy-run";
import { OVERLAP_CAPABILITY } from "./overlap";
import { REPLICAS_CAPABILITY } from "./replicas";

let db: TestDb;
let pg: PGlite;
let sent: DeployRequest[] = [];
const CAPS = [
  "deploy.network",
  "deploy.compose.multi",
  "deploy.ready-check",
  OVERLAP_CAPABILITY,
  REPLICAS_CAPABILITY,
];
let caps: string[] = CAPS;
const realFetch = globalThis.fetch;

const fakeAgent = () =>
  new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === "then") return undefined;
        if (prop === "close") return () => {};
        if (prop === "hello")
          return async () => ({
            contractVersion: ContractVersion.CONTRACT_VERSION_V1,
            dockerAvailable: true,
            agentVersion: "9.9.9",
            capabilities: caps,
          });
        if (prop === "deploy")
          return async function* (req: DeployRequest) {
            sent.push(req);
            yield {
              seq: 1,
              result: {
                ready: true,
                error: "",
                commitSha: "",
                observedPort: 0,
                builtWith: "",
                listeningPorts: [],
              },
            };
          };
        return async () => ({ ok: true, exists: false, yaml: "", error: "" });
      },
    },
  ) as unknown as AgentConnection;

const stack = (web = "", rest = "") => `services:
  web:
    image: nginx:1.27
    expose: ["80"]
    deploy:
      replicas: 3
${web}  worker:
    image: acme/worker:1
    depends_on: [web]
${rest}`;

type Svc = {
  labels: string[];
  depends_on?: unknown;
  healthcheck?: { test: string[] };
  deploy?: { replicas?: number };
};
const servicesOf = (y: string) =>
  (yaml.load(y) as { services: Record<string, Svc> }).services;
const routing = (svc: Svc) =>
  svc.labels.filter((l) => l.startsWith("traefik.")).sort();

async function setCompose(compose: string): Promise<void> {
  await db
    .update(apps)
    .set({ source: "compose", compose })
    .where(eq(apps.id, "prj_1"));
}

const logs = async () =>
  (await db.select().from(deploymentLogs)).map((l) => l.text).join("\n");

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
  globalThis.fetch = (async () =>
    new Response("offline", { status: 503 })) as typeof fetch;
  __setAgentConnectorForTest(async () => fakeAgent());
});

after(async () => {
  globalThis.fetch = realFetch;
  __setAgentConnectorForTest();
  __resetTestDb();
  await pg.close();
});

beforeEach(async () => {
  sent = [];
  caps = [...CAPS, STACK_OVERLAP_CAPABILITY];
  await pg.exec(`${TRUNCATE_PROJECT_GRAPH}
    truncate table users, teams restart identity cascade;`);
  await seedIdentity(db, {
    users: [{ id: USER_1, teamId: TEAM_A, role: "owner" }],
  });
  await seedServer(db);
  await seedApp(db, { id: "prj_1", teamId: TEAM_A, slug: "shop", repo: null });
  await setCompose(stack());
  await db.insert(domains).values({
    id: "dom_1",
    appId: "prj_1",
    name: "shop.example.com",
    status: "valid",
    isPrimary: true,
    ssl: false,
    certProvider: "none",
    service: "web",
    port: 80,
    createdAt: "2026-11-11T00:00:00.000Z",
  });
  await seedDeployment(db, { id: "dpl_1", appId: "prj_1", status: "queued" });
});

async function deploy(): Promise<DeployRequest> {
  await runDeploymentGuarded("dpl_1");
  assert.equal(sent.length, 1, await logs());
  return sent[0];
}

describe("a compose stack with replicas starts beside the live one", () => {
  test("the agent gets the whole stack again as a stand-in, under names of its own", async () => {
    const req = await deploy();
    const live = servicesOf(req.composeYaml);
    const next = servicesOf(req.standInComposeYaml);
    assert.deepEqual(Object.keys(live).sort(), ["web", "worker"]);
    assert.deepEqual(Object.keys(next).sort(), ["web_next", "worker_next"]);
    assert.equal(next.web_next.deploy?.replicas, 3);
    assert.deepEqual(next.worker_next.depends_on, ["web_next"]);
    for (const svc of Object.values(next))
      assert.ok(svc.labels.includes("deplo.stand-in=true"));
    for (const svc of Object.values(live))
      assert.ok(!svc.labels.includes("deplo.stand-in=true"));
  });

  // Identical routers: the proxy shares visitors between both instead of dropping a conflict.
  test("the stand-in carries exactly the live stack's routes", async () => {
    const req = await deploy();
    const live = servicesOf(req.composeYaml);
    const next = servicesOf(req.standInComposeYaml);
    assert.ok(routing(live.web).some((l) => l.includes("shop.example.com")));
    assert.deepEqual(routing(next.web_next), routing(live.web));
    assert.deepEqual(routing(next.worker_next), routing(live.worker));
  });
});

describe("names on the Environment's network", () => {
  type Nets = Record<string, { aliases?: string[] } | null>;
  const nets = (y: string, service: string) =>
    (servicesOf(y)[service] as unknown as { networks: Nets | string[] })
      .networks;

  // Other stacks reach `web` by name there: until the swap that is the live release only.
  test("a stand-in answers there only to its own name", async () => {
    const req = await deploy();
    assert.deepEqual(nets(req.composeYaml, "web"), ["deplo"]);
    assert.deepEqual(nets(req.standInComposeYaml, "web_next"), { deplo: null });
  });

  test("on the stack's own network it answers to the service's name, so the stand-in reaches itself", async () => {
    await setCompose(
      stack("    networks: [backend]\n", "networks:\n  backend: {}\n"),
    );
    const req = await deploy();
    assert.deepEqual(nets(req.standInComposeYaml, "web_next"), {
      backend: { aliases: ["web"] },
      deplo: null,
    });
  });
});

describe("visitors reach a copy only once it listens", () => {
  test("a routed service with no health check gets the port probe, live and stand-in alike", async () => {
    const req = await deploy();
    for (const [y, name] of [
      [req.composeYaml, "web"],
      [req.standInComposeYaml, "web_next"],
    ] as const) {
      const hc = servicesOf(y)[name].healthcheck as Record<string, unknown>;
      assert.equal((hc.test as string[])[0], "CMD-SHELL");
      assert.match((hc.test as string[])[1], /\/proc\/net\/tcp/);
      assert.equal(hc.start_interval, "1s");
    }
    assert.equal(servicesOf(req.composeYaml).worker.healthcheck, undefined);
  });

  test("its own health check is kept", async () => {
    await setCompose(stack('    healthcheck:\n      test: ["CMD", "true"]\n'));
    const req = await deploy();
    assert.deepEqual(servicesOf(req.composeYaml).web.healthcheck?.test, [
      "CMD",
      "true",
    ]);
  });
});

describe("a stack that cannot run twice deploys as it always did, and says why", () => {
  const inPlace = async (compose: string, why: RegExp) => {
    await setCompose(compose);
    const req = await deploy();
    assert.equal(req.standInComposeYaml, "");
    assert.equal(servicesOf(req.composeYaml).web.healthcheck, undefined);
    assert.match(await logs(), why);
    assert.match(await logs(), /goes offline briefly/);
  };

  test("a service that keeps data in a named volume", () =>
    inPlace(
      stack(
        "",
        "  cache:\n    image: redis:7\n    volumes:\n      - data:/data\nvolumes:\n  data: {}\n",
      ),
      /Service `cache` keeps data on the server's disk/,
    ));

  test("a service that opens a port on the server", () =>
    inPlace(
      stack("", '  mail:\n    image: acme/mail:1\n    ports: ["25:25"]\n'),
      /Service `mail` keeps data on the server's disk or opens a port/,
    ));

  test("a service that fixes its hostname", () =>
    inPlace(stack("    hostname: shop\n"), /Service `web` sets `hostname`/));

  test("a network with an address range of its own", () =>
    inPlace(
      stack(
        "    networks: [lan]\n",
        "networks:\n  lan:\n    ipam:\n      config:\n        - subnet: 10.9.0.0/24\n",
      ),
      /network `lan` sets `ipam`/,
    ));

  test("a service already called what the stand-in would be", () =>
    inPlace(
      stack("", "  web_next:\n    image: acme/x:1\n"),
      /starts as `web_next`, a name this environment already uses/,
    ));

  test("Files do not count as data on disk", async () => {
    await setCompose(stack("    volumes:\n      - ./conf:/etc/conf\n"));
    assert.notEqual((await deploy()).standInComposeYaml, "");
  });

  test("a stack that asks for one copy of everything is left alone, silently", async () => {
    await setCompose(stack().replace("replicas: 3", "replicas: 1"));
    const req = await deploy();
    assert.equal(req.standInComposeYaml, "");
    assert.equal(servicesOf(req.composeYaml).web.healthcheck, undefined);
    assert.doesNotMatch(await logs(), /offline briefly/);
  });
});

describe("a server that cannot start a stack beside itself", () => {
  test("an older server agent is named, and nothing is swapped in place", async () => {
    caps = CAPS;
    await runDeploymentGuarded("dpl_1");
    assert.equal(sent.length, 0);
    assert.match(
      await logs(),
      /3 copies needs the new version to start beside the old one\. This server's agent is too old/,
    );
  });

  test("Docker older than 25 fails the deploy the same way", async () => {
    await db.update(servers).set({ dockerVersion: "24.0.7" });
    await runDeploymentGuarded("dpl_1");
    assert.equal(sent.length, 0);
    assert.match(await logs(), /Docker is older than version 25/);
  });
});

describe("what rides along with the live stack", () => {
  // The connector sends visitors to the proxy, which already shares them between both copies.
  test("the App's tunnel connector is held back in the live stack and never runs in the stand-in", async () => {
    caps = [...caps, "deploy.start-after-ready"];
    const at = "2026-11-11T00:00:00.000Z";
    await db.insert(dnsProviders).values({
      id: "dnsp_1",
      userId: USER_1,
      provider: "cloudflare",
      zoneName: "example.com",
      zoneId: "z1",
      accountId: "a1",
      apiTokenEnc: encryptSecret("cf-token"),
      createdAt: at,
      updatedAt: at,
    });
    await db.insert(appTunnels).values({
      appId: "prj_1",
      providerId: "dnsp_1",
      tunnelId: "tun_1",
      tokenEnc: encryptSecret("runtoken"),
      createdAt: at,
    });
    await db.insert(appTunnelDomains).values({
      domainId: "dom_1",
      appId: "prj_1",
      providerId: "dnsp_1",
      active: true,
      createdAt: at,
    });
    const req = await deploy();
    const connector = appConnectorService("shop");
    assert.deepEqual(req.startAfterReady, [connector]);
    assert.ok(connector in servicesOf(req.composeYaml));
    assert.deepEqual(Object.keys(servicesOf(req.standInComposeYaml)).sort(), [
      "web_next",
      "worker_next",
    ]);
  });

  test("the restart rule and the ready check still name the live service", async () => {
    caps = [...caps, "health.restart"];
    const req = await deploy();
    assert.equal(req.ready?.service, "web");
    assert.equal(req.restartRule?.service, "web");
  });
});
