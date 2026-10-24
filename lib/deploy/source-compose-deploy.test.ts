import { test, before, after, beforeEach } from "node:test";
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
import { appBuild, apps } from "../db/schema/control-plane/apps";
import { deployments } from "../db/schema/control-plane/deployments";
import { domains } from "../db/schema/control-plane/domains";
import {
  BuildKind,
  ContractVersion,
  type DeployEvent,
  type DeployRequest,
} from "../agent/gen/agent";
import { runDeploymentGuarded } from "./build/deploy-run";

const SHA = "c".repeat(40);
const COMPOSE = `services:
  web:
    build: ./web
    image: postgres:16
    ports: ["8080:3000"]
    volumes: ["./data:/data"]
  cache:
    image: redis:7-alpine
`;
let db: TestDb;
let pg: PGlite;
let sent: DeployRequest[] = [];
let answer: (req: DeployRequest) => DeployEvent["result"];
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
            capabilities: [
              "deploy.network",
              "git.commit",
              "deploy.railpack",
              "deploy.compose.multi",
              "deploy.compose.source",
              "build.auto-method",
              "deploy.ready-check",
            ],
          });
        if (prop === "deploy")
          return async function* (req: DeployRequest) {
            sent.push(req);
            yield { seq: 1, result: answer(req) };
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
  await pg.exec(`${TRUNCATE_PROJECT_GRAPH}
    truncate table users, teams restart identity cascade;`);
  await seedIdentity(db, {
    users: [{ id: USER_1, teamId: TEAM_A, role: "owner" }],
  });
  await seedServer(db);
  await seedApp(db, {
    id: "prj_1",
    teamId: TEAM_A,
    slug: "shop",
    repo: {
      provider: "github",
      url: "https://github.com/acme/shop",
      repo: "acme/shop",
      branch: "main",
    },
  });
  await db
    .update(appBuild)
    .set({ buildMethodAuto: true })
    .where(eq(appBuild.appId, "prj_1"));
  await db.insert(domains).values({
    id: "dom_1",
    appId: "prj_1",
    name: "shop.example.com",
    status: "valid",
    isPrimary: true,
    ssl: false,
    certProvider: "none",
    port: 3000,
    createdAt: "2026-10-24T00:00:00.000Z",
  });
  await seedDeployment(db, { id: "dpl_1", appId: "prj_1", status: "queued" });
});

test("a repository's compose file is read, then deployed as a stack under its own agent deploy id", async () => {
  answer = (req) =>
    req.buildKind === BuildKind.BUILD_KIND_COMPOSE
      ? {
          ready: true,
          error: "",
          commitSha: SHA,
          observedPort: 0,
          builtWith: "",
          listeningPorts: [],
        }
      : {
          ready: false,
          error: "",
          commitSha: SHA,
          observedPort: 0,
          builtWith: "",
          listeningPorts: [],
          sourceCompose: { path: "docker-compose.yml", content: COMPOSE },
        };
  await runDeploymentGuarded("dpl_1");

  assert.equal(sent.length, 2, "one read, one deploy");
  const [read, stack] = sent;
  assert.equal(read.buildKind, BuildKind.BUILD_KIND_RAILPACK);
  assert.equal(read.buildSpec?.autoMethod, true);
  // The agent replays an id it already ran, so the stack leg must not reuse it.
  assert.notEqual(stack.deployId, read.deployId);
  assert.equal(stack.buildKind, BuildKind.BUILD_KIND_COMPOSE);
  assert.equal(stack.git?.commit, SHA, "the stack is the commit that was read");
  assert.match(stack.composeYaml, /\/data\/stacks\/shop\.src\/web/);
  assert.match(stack.composeYaml, /\/data\/stacks\/shop\.src\/data:\/data/);
  assert.doesNotMatch(stack.composeYaml, /8080:3000/);
  assert.doesNotMatch(stack.composeYaml, /image: postgres:16/);
  assert.equal(stack.ready?.service, "web");
  assert.equal(stack.ready?.port, 3000);

  const dep = (
    await db.select().from(deployments).where(eq(deployments.id, "dpl_1"))
  )[0];
  assert.equal(dep.status, "ready");
  assert.equal(
    dep.imageRef,
    null,
    "a stack has no single image to roll back to",
  );
  const app = (await db.select().from(apps).where(eq(apps.id, "prj_1")))[0];
  assert.match(app.compose ?? "", /deplo\/shop-web:/);
  const build = (
    await db.select().from(appBuild).where(eq(appBuild.appId, "prj_1"))
  )[0];
  assert.equal(build.buildMethod, "compose");
  assert.equal(build.buildMethodAuto, true, "still Detect automatically");
  const dom = (
    await db.select().from(domains).where(eq(domains.id, "dom_1"))
  )[0];
  assert.equal(dom.service, "web");
});

test("a compose file that reaches the server is refused before anything runs", async () => {
  answer = () => ({
    ready: false,
    error: "",
    commitSha: SHA,
    observedPort: 0,
    builtWith: "",
    listeningPorts: [],
    sourceCompose: {
      path: "compose.yaml",
      content: "services:\n  web:\n    build: .\n    privileged: true\n",
    },
  });
  await runDeploymentGuarded("dpl_1");
  assert.equal(sent.length, 1, "only the read reached the agent");
  const dep = (
    await db.select().from(deployments).where(eq(deployments.id, "dpl_1"))
  )[0];
  assert.equal(dep.status, "error");
});

test("Detect automatically records the Dockerfile the agent found", async () => {
  answer = () => ({
    ready: true,
    error: "",
    commitSha: SHA,
    observedPort: 0,
    builtWith: "dockerfile",
    listeningPorts: [3000],
  });
  await runDeploymentGuarded("dpl_1");
  assert.equal(sent.length, 1);
  const build = (
    await db.select().from(appBuild).where(eq(appBuild.appId, "prj_1"))
  )[0];
  assert.equal(build.buildMethod, "dockerfile");
  assert.equal(build.buildMethodAuto, true);
});

test("a port the app really listens on is adopted, with its domains", async () => {
  answer = () => ({
    ready: true,
    error: "",
    commitSha: SHA,
    observedPort: 8080,
    builtWith: "railpack",
    listeningPorts: [8080],
  });
  await runDeploymentGuarded("dpl_1");
  const build = (
    await db.select().from(appBuild).where(eq(appBuild.appId, "prj_1"))
  )[0];
  assert.equal(build.port, 8080);
  const dom = (
    await db.select().from(domains).where(eq(domains.id, "dom_1"))
  )[0];
  assert.equal(dom.port, 8080);
  assert.equal(sent[0].ready?.port, 3000);
  assert.equal(sent[0].ready?.portRequired, true);
});

test("a compose file of images only falls back to Railpack under Detect automatically", async () => {
  answer = (req) =>
    req.buildSpec?.autoMethod
      ? {
          ready: false,
          error: "",
          commitSha: SHA,
          observedPort: 0,
          builtWith: "",
          listeningPorts: [],
          sourceCompose: {
            path: "docker-compose.yml",
            content: "services:\n  mysql:\n    image: mysql:9\n",
          },
        }
      : {
          ready: true,
          error: "",
          commitSha: SHA,
          observedPort: 0,
          builtWith: "",
          listeningPorts: [3000],
        };
  await runDeploymentGuarded("dpl_1");
  assert.equal(sent.length, 2);
  const [, railpack] = sent;
  assert.equal(railpack.buildKind, BuildKind.BUILD_KIND_RAILPACK);
  assert.equal(railpack.buildSpec?.autoMethod, false);
  assert.equal(railpack.git?.commit, SHA);
  assert.notEqual(railpack.deployId, sent[0].deployId);
  const dep = (
    await db.select().from(deployments).where(eq(deployments.id, "dpl_1"))
  )[0];
  assert.equal(dep.status, "ready");
  const build = (
    await db.select().from(appBuild).where(eq(appBuild.appId, "prj_1"))
  )[0];
  assert.equal(build.buildMethod, "railpack");
  const app = (await db.select().from(apps).where(eq(apps.id, "prj_1")))[0];
  assert.equal(app.compose, null, "no stack was stored");
});

test("a repository's traefik labels never route, even when an admin saved labels for the app", async () => {
  await db
    .update(apps)
    .set({ traefikLabelsBy: USER_1 })
    .where(eq(apps.id, "prj_1"));
  answer = (req) =>
    req.buildKind === BuildKind.BUILD_KIND_COMPOSE
      ? {
          ready: true,
          error: "",
          commitSha: SHA,
          observedPort: 0,
          builtWith: "",
          listeningPorts: [],
        }
      : {
          ready: false,
          error: "",
          commitSha: SHA,
          observedPort: 0,
          builtWith: "",
          listeningPorts: [],
          sourceCompose: {
            path: "compose.yaml",
            content:
              'services:\n  web:\n    build: .\n    expose: ["3000"]\n    labels:\n      - traefik.http.routers.evil.rule=Host(`victim.example.com`)\n',
          },
        };
  await runDeploymentGuarded("dpl_1");
  assert.equal(sent.length, 2);
  assert.doesNotMatch(sent[1].composeYaml, /victim\.example\.com/);
});

test("a stack's real port is adopted from the port its check used", async () => {
  answer = (req) =>
    req.buildKind === BuildKind.BUILD_KIND_COMPOSE
      ? {
          ready: true,
          error: "",
          commitSha: SHA,
          observedPort: 8080,
          builtWith: "",
          listeningPorts: [8080],
        }
      : {
          ready: false,
          error: "",
          commitSha: SHA,
          observedPort: 0,
          builtWith: "",
          listeningPorts: [],
          sourceCompose: { path: "docker-compose.yml", content: COMPOSE },
        };
  await runDeploymentGuarded("dpl_1");
  const dom = (
    await db.select().from(domains).where(eq(domains.id, "dom_1"))
  )[0];
  assert.equal(dom.service, "web");
  assert.equal(dom.port, 8080);
});

test("a single-image deploy drops the stack a source deployed before", async () => {
  await db.update(apps).set({ compose: COMPOSE }).where(eq(apps.id, "prj_1"));
  await db
    .update(appBuild)
    .set({ buildMethodAuto: false, buildMethod: "railpack" })
    .where(eq(appBuild.appId, "prj_1"));
  answer = () => ({
    ready: true,
    error: "",
    commitSha: SHA,
    observedPort: 0,
    builtWith: "",
    listeningPorts: [3000],
  });
  await runDeploymentGuarded("dpl_1");
  const app = (await db.select().from(apps).where(eq(apps.id, "prj_1")))[0];
  assert.equal(app.compose, null);
});

test("a stack that fails is not stored as the app's stack", async () => {
  answer = (req) =>
    req.buildKind === BuildKind.BUILD_KIND_COMPOSE
      ? {
          ready: false,
          error: "Service web keeps restarting (exit code 1)",
          commitSha: SHA,
          observedPort: 0,
          builtWith: "",
          listeningPorts: [],
        }
      : {
          ready: false,
          error: "",
          commitSha: SHA,
          observedPort: 0,
          builtWith: "",
          listeningPorts: [],
          sourceCompose: { path: "docker-compose.yml", content: COMPOSE },
        };
  await runDeploymentGuarded("dpl_1");
  const app = (await db.select().from(apps).where(eq(apps.id, "prj_1")))[0];
  assert.equal(app.compose, null);
  const logs = (
    await pg.query<{ text: string }>(
      "select text from deployment_logs order by id",
    )
  ).rows.map((r) => r.text);
  assert.ok(logs.some((l) => /keeps restarting/.test(l)));
  assert.ok(
    !logs.some((l) => /Stack did not reach a running state/.test(l)),
    "the agent's reason is the last word",
  );
});
