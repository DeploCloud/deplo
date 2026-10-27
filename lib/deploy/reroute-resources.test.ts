import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { PGlite } from "@electric-sql/pglite";
import * as yaml from "js-yaml";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { runWithIdentity } from "../auth/request-context";
import { seedIdentity, TEAM_A, USER_1 } from "../data/identity-test-helpers";
import {
  seedApp,
  seedServer,
  TRUNCATE_PROJECT_GRAPH,
} from "../data/app-graph-test-helpers";
import { __setAgentConnectorForTest } from "../infra/agent-client/connect";
import type { AgentConnection } from "../infra/agent-client/connection";
import type { ResourceLimits } from "../types/container";
import { renderCompose } from "./build/compose-render";
import { rerouteApp } from "./build/reroute";
import { parseStackResources } from "./build/stack-yaml";
import {
  RESOURCE_COMPOSE_KEYS,
  resourceLimitsToComposeKeys,
} from "./resources";

let db: TestDb;
let pg: PGlite;
let deployed = "";
let sent: string | undefined;

function fakeAgent(): AgentConnection {
  return {
    readStack: async () => ({ exists: true, yaml: deployed }),
    reroute: async (req: { composeYaml: string }) => {
      sent = req.composeYaml;
      return { ok: true, error: "" };
    },
    close: () => {},
  } as unknown as AgentConnection;
}

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
  __setAgentConnectorForTest(async () => fakeAgent());
});

after(async () => {
  __setAgentConnectorForTest();
  __resetTestDb();
  await pg.close();
});

beforeEach(async () => {
  sent = undefined;
  await pg.exec(`${TRUNCATE_PROJECT_GRAPH}
    truncate table users, teams restart identity cascade;`);
  await seedIdentity(db, {
    users: [{ id: USER_1, teamId: TEAM_A, role: "owner" }],
  });
  await seedServer(db);
});

const limits = (p: Partial<ResourceLimits>): ResourceLimits =>
  ({
    memoryMb: null,
    memoryReservationMb: null,
    swapMb: null,
    cpuMilli: null,
    cpuShares: null,
    cpuset: null,
    pidsLimit: null,
    shmSizeMb: null,
    storageGb: null,
    nofile: null,
    nproc: null,
    oomScoreAdj: null,
    ...p,
  }) as ResourceLimits;

const reroute = (id: string) =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, () => rerouteApp(id));

const service = (stack: string, name: string) =>
  (yaml.load(stack) as { services: Record<string, Record<string, unknown>> })
    .services[name];

const single = (resources: ResourceLimits | null) =>
  renderCompose({
    network: "deplo-team-team_test",
    name: "deplo-web",
    image: "deplo/web:abc",
    port: 3000,
    appId: "app_1",
    deployKey: "web",
    routes: [],
    env: { FOO: "bar" },
    resources,
  });

test("a single-image reroute keeps the limits the app was deployed with", async () => {
  // Saved since the deploy: the new value waits for the next deploy, the old one must not vanish.
  await seedApp(db, {
    id: "app_1",
    slug: "web",
    source: "docker-image",
    repo: null,
    resources: limits({ memoryMb: 1024 }),
  });
  deployed = single(limits({ memoryMb: 512, cpuMilli: 500, nofile: 1024 }));

  assert.equal(await reroute("app_1"), "rerouted");
  const svc = service(sent!, "deplo-web");
  assert.equal(svc.mem_limit, "512m");
  assert.equal(svc.cpus, "0.5");
  assert.deepEqual(svc.ulimits, { nofile: 1024 });
});

test("a compose stack's reroute keeps the app's limits on every service", async () => {
  await seedApp(db, {
    id: "app_1",
    slug: "web",
    source: "compose",
    status: "active",
    compose: `services:\n  web:\n    image: nginx\n  worker:\n    image: busybox\n    mem_limit: 2g\n`,
    resources: limits({ memoryMb: 512, pidsLimit: 100 }),
  });
  deployed = "services: {}\n";

  assert.equal(await reroute("app_1"), "rerouted");
  assert.equal(service(sent!, "web").mem_limit, "512m");
  assert.equal(service(sent!, "web").pids_limit, 100);
  assert.equal(service(sent!, "worker").mem_limit, "2g");
});

test("re-rendering a deployed single-image stack from its own limits is byte-identical", () => {
  const all = limits({
    memoryMb: 512,
    memoryReservationMb: 256,
    swapMb: 1024,
    cpuMilli: 1500,
    cpuShares: 512,
    cpuset: "0-1",
    pidsLimit: 100,
    shmSizeMb: 64,
    storageGb: 10,
    nofile: 1024,
    nproc: 512,
    oomScoreAdj: 100,
  });
  const out = single(all);
  const keys = parseStackResources(out, "deplo-web");
  assert.deepEqual(
    Object.keys(keys ?? {}).sort(),
    [...RESOURCE_COMPOSE_KEYS].sort(),
  );
  assert.deepEqual(
    Object.keys(resourceLimitsToComposeKeys(all)).sort(),
    [...RESOURCE_COMPOSE_KEYS].sort(),
  );
  const again = renderCompose({
    network: "deplo-team-team_test",
    name: "deplo-web",
    image: "deplo/web:abc",
    port: 3000,
    appId: "app_1",
    deployKey: "web",
    routes: [],
    env: { FOO: "bar" },
    resourceKeys: keys,
  });
  assert.equal(again, out);
  assert.equal(parseStackResources(single(null), "deplo-web"), null);
});
