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
import { apps, appPorts } from "../db/schema/control-plane/apps";
import { domains } from "../db/schema/control-plane/domains";
import { servers } from "../db/schema/control-plane/servers";
import { ContractVersion, type DeployRequest } from "../agent/gen/agent";
import { runDeploymentGuarded } from "./build/deploy-run";
import { OVERLAP_CAPABILITY } from "./overlap";

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
  caps = [...CAPS, OVERLAP_CAPABILITY];
  await pg.exec(`${TRUNCATE_PROJECT_GRAPH}
    truncate table users, teams restart identity cascade;`);
  await seedIdentity(db, {
    users: [{ id: USER_1, teamId: TEAM_A, role: "owner" }],
  });
  await seedServer(db);
  await seedApp(db, { id: "prj_1", teamId: TEAM_A, slug: "web", repo: null });
  await db
    .update(apps)
    .set({
      source: "docker-image",
      dockerImage: "nginx:1.27",
      zeroDowntimeDeploys: true,
    })
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

describe("a redeploy keeps the old version online", () => {
  test("only an app that turned zero-downtime deploys on gets a stand-in", async () => {
    await db
      .update(apps)
      .set({ zeroDowntimeDeploys: false })
      .where(eq(apps.id, "prj_1"));
    const req = await deploy();
    assert.equal(req.standInComposeYaml, "");
    assert.doesNotMatch(req.composeYaml, /healthcheck:/);
  });

  test("a current server gets the stand-in, and a live stack the proxy waits on", async () => {
    const req = await deploy();
    assert.match(req.standInComposeYaml, /container_name: deplo-web_next\n/);
    assert.match(req.standInComposeYaml, /aliases:\n\s+- deplo-web\n/);
    assert.match(req.composeYaml, /container_name: deplo-web\n/);
    assert.match(req.composeYaml, /healthcheck:/);
  });

  test("an older agent gets the in-place stack it always did", async () => {
    caps = CAPS;
    const req = await deploy();
    assert.equal(req.standInComposeYaml, "");
    assert.doesNotMatch(req.composeYaml, /healthcheck:/);
  });

  test("a server on Docker older than 25 swaps in place", async () => {
    await db.update(servers).set({ dockerVersion: "24.0.7" });
    const req = await deploy();
    assert.equal(req.standInComposeYaml, "");
    assert.doesNotMatch(req.composeYaml, /healthcheck:/);
  });

  test("an app that opens ports on the server swaps in place", async () => {
    await db.insert(appPorts).values({
      portId: "prt_1",
      appId: "prj_1",
      published: 25565,
      target: 25565,
      protocol: "tcp",
      position: 0,
    });
    const req = await deploy();
    assert.equal(req.standInComposeYaml, "");
    assert.match(req.composeYaml, /25565:25565/);
  });
});
