import { test, before, after, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";
import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { __setAgentConnectorForTest } from "../infra/agent-client/connect";
import type { AgentConnection } from "../infra/agent-client/connection";
import { seedIdentity, TEAM_A, USER_1 } from "../data/identity-test-helpers";
import {
  seedApp,
  seedDeployment,
  seedServer,
  TRUNCATE_PROJECT_GRAPH,
} from "../data/app-graph-test-helpers";
import { apps } from "../db/schema/control-plane/apps";
import { domains } from "../db/schema/control-plane/domains";
import {
  ContractVersion,
  RestartRule_Probe,
  type DeployRequest,
} from "../agent/gen/agent";
import { runDeploymentGuarded } from "./build/deploy-run";
import { RESTART_CAPABILITY } from "../infra/agent-client/hello-capabilities";

let db: TestDb;
let pg: PGlite;
let sent: DeployRequest[] = [];
const CAPS = [
  "deploy.network",
  "deploy.image",
  "deploy.railpack",
  "deploy.ready-check",
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
  caps = [...CAPS, RESTART_CAPABILITY];
  await pg.exec(`${TRUNCATE_PROJECT_GRAPH}
    truncate table users, teams restart identity cascade;`);
  await seedIdentity(db, {
    users: [{ id: USER_1, teamId: TEAM_A, role: "owner" }],
  });
  await seedServer(db);
  await seedApp(db, { id: "prj_1", teamId: TEAM_A, slug: "web", repo: null });
  await db
    .update(apps)
    .set({ source: "docker-image", dockerImage: "nginx:1.27" })
    .where(eq(apps.id, "prj_1"));
  await db.insert(domains).values({
    id: "dom_1",
    appId: "prj_1",
    name: "web.example.com",
    status: "valid",
    isPrimary: true,
    ssl: false,
    certProvider: "none",
    port: 3000,
    createdAt: "2026-11-08T00:00:00.000Z",
  });
  await seedDeployment(db, { id: "dpl_1", appId: "prj_1", status: "queued" });
});

async function deploy(): Promise<DeployRequest> {
  await runDeploymentGuarded("dpl_1");
  assert.equal(sent.length, 1);
  return sent[0];
}

describe("the deploy carries the restart rule", () => {
  test("an app with a domain and no check gets the default rule", async () => {
    const rule = (await deploy()).restartRule;
    assert.equal(rule?.probe, RestartRule_Probe.PROBE_HTTP);
    assert.equal(rule?.port, 3000);
    assert.equal(rule?.path, "/");
    assert.equal(rule?.intervalS, 30);
    assert.equal(rule?.timeoutS, 10);
    assert.equal(rule?.startPeriodS, 60);
  });

  test("the app's own http check replaces the default", async () => {
    await db
      .update(apps)
      .set({
        healthCheckEnabled: true,
        healthCheckType: "http",
        healthCheckPath: "/up",
        healthCheckPort: 4000,
        healthCheckIntervalS: 20,
        healthCheckTimeoutS: 5,
        healthCheckRetries: 4,
        healthCheckStartPeriodS: 15,
      })
      .where(eq(apps.id, "prj_1"));
    const rule = (await deploy()).restartRule;
    assert.equal(rule?.probe, RestartRule_Probe.PROBE_HTTP);
    assert.equal(rule?.port, 4000);
    assert.equal(rule?.path, "/up");
    assert.equal(rule?.retries, 4);
  });

  test("a command check is left to Docker's own health", async () => {
    await db
      .update(apps)
      .set({
        healthCheckEnabled: true,
        healthCheckType: "command",
        healthCheckCommand: "curl -f localhost:3000",
      })
      .where(eq(apps.id, "prj_1"));
    const rule = (await deploy()).restartRule;
    assert.equal(rule?.probe, RestartRule_Probe.PROBE_DOCKER_HEALTH);
  });

  test("a worker with no domain gets no rule", async () => {
    await db.delete(domains);
    assert.equal((await deploy()).restartRule, undefined);
  });

  test("the switch off sends no rule", async () => {
    await db
      .update(apps)
      .set({ restartWhenUnresponsive: false })
      .where(eq(apps.id, "prj_1"));
    assert.equal((await deploy()).restartRule, undefined);
  });

  test("an older server agent gets none, and the deploy still goes", async () => {
    caps = CAPS;
    assert.equal((await deploy()).restartRule, undefined);
  });
});
