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
  seedPreview,
  seedServer,
  TRUNCATE_PROJECT_GRAPH,
} from "../data/app-graph-test-helpers";
import { appBuild, apps } from "../db/schema/control-plane/apps";
import {
  appPreviews,
  deployments,
} from "../db/schema/control-plane/deployments";
import { domains } from "../db/schema/control-plane/domains";
import { registries } from "../db/schema/control-plane/integrations";
import { encryptSecret } from "../crypto";
import {
  BuildKind,
  ContractVersion,
  type DeployEvent,
  type DeployRequest,
} from "../agent/gen/agent";
import { runDeploymentGuarded } from "./build/deploy-run";

const SHA = "c".repeat(40);
const PROD_STACK = "services:\n  web:\n    image: deplo/shop-web:prod\n";
const COMPOSE = `services:
  web:
    build: ./web
    expose: ["3000"]
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

const result = (
  over: Partial<NonNullable<DeployEvent["result"]>>,
): DeployEvent["result"] => ({
  ready: false,
  error: "",
  commitSha: SHA,
  observedPort: 0,
  builtWith: "",
  listeningPorts: [],
  ...over,
});

const appRow = async () =>
  (await db.select().from(apps).where(eq(apps.id, "prj_1")))[0];
const buildRow = async () =>
  (await db.select().from(appBuild).where(eq(appBuild.appId, "prj_1")))[0];
const depRow = async () =>
  (await db.select().from(deployments).where(eq(deployments.id, "dpl_1")))[0];

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
  // Production already runs a stack read from the repository.
  await db
    .update(apps)
    .set({ compose: PROD_STACK })
    .where(eq(apps.id, "prj_1"));
  await db
    .update(appBuild)
    .set({ buildMethodAuto: true, buildMethod: "compose" })
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
    service: "web",
    createdAt: "2026-10-24T00:00:00.000Z",
  });
  await seedPreview(db, { id: "prv_1", appId: "prj_1", prNumber: 7 });
  await seedDeployment(db, {
    id: "dpl_1",
    appId: "prj_1",
    status: "queued",
    environment: "preview",
    previewId: "prv_1",
    prNumber: 7,
    deployKey: "shop__pr-7",
  });
});

test("a preview that builds a single image leaves the app's stack and method alone", async () => {
  answer = () => result({ ready: true, listeningPorts: [3000] });
  await runDeploymentGuarded("dpl_1");
  assert.equal((await depRow()).status, "ready");
  assert.equal((await appRow()).compose, PROD_STACK);
  assert.equal((await buildRow()).buildMethod, "compose");
  assert.equal(sent[0].buildKind, BuildKind.BUILD_KIND_RAILPACK);
});

// The first leg reads the pull request's compose file, the second brings it up.
const stackLegs = (req: DeployRequest) =>
  req.buildKind === BuildKind.BUILD_KIND_COMPOSE && req.composeYaml
    ? result({ ready: true })
    : result({
        sourceCompose: { path: "docker-compose.yml", content: COMPOSE },
      });

const seedRegistry = () =>
  db.insert(registries).values({
    id: "reg_1",
    teamId: TEAM_A,
    name: "Private",
    type: "generic",
    registryUrl: "registry.acme.test",
    username: "ci",
    passwordEnc: encryptSecret("hunter2"),
    createdAt: "2026-10-24T00:00:00.000Z",
  });

test("a preview deploys the pull request's compose file as its own stack", async () => {
  await db.update(apps).set({ compose: null }).where(eq(apps.id, "prj_1"));
  await db
    .update(appBuild)
    .set({ buildMethod: "railpack" })
    .where(eq(appBuild.appId, "prj_1"));
  await db
    .update(domains)
    .set({ service: null })
    .where(eq(domains.id, "dom_1"));
  await seedRegistry();
  answer = stackLegs;
  await runDeploymentGuarded("dpl_1");

  assert.equal((await depRow()).status, "ready");
  assert.equal(sent.length, 2);
  const stack = sent[1];
  assert.equal(stack.buildKind, BuildKind.BUILD_KIND_COMPOSE);
  assert.equal(stack.slug, "shop__pr-7");
  assert.equal(stack.network, "deplo-preview-shop__pr-7");
  assert.match(stack.composeYaml, /\/data\/stacks\/shop__pr-7\.src\/web/);
  assert.match(stack.composeYaml, /shop-pr-7\.example\.test/);
  assert.doesNotMatch(stack.composeYaml, /shop\.example\.com/);
  assert.equal(stack.ready?.service, "web");
  assert.equal(stack.registryAuth.length, 1, "a member's pull request pulls");

  assert.equal((await appRow()).compose, null, "production stores no stack");
  assert.equal((await buildRow()).buildMethod, "railpack");
  const dom = (
    await db.select().from(domains).where(eq(domains.id, "dom_1"))
  )[0];
  assert.equal(dom.service, null, "production's domain is not rerouted");
});

test("a preview of an app set to Docker Compose deploys its stack", async () => {
  await db
    .update(appBuild)
    .set({ buildMethodAuto: false })
    .where(eq(appBuild.appId, "prj_1"));
  answer = stackLegs;
  await runDeploymentGuarded("dpl_1");
  assert.equal((await depRow()).status, "ready");
  assert.equal(sent.length, 2);
  assert.equal(sent[0].buildKind, BuildKind.BUILD_KIND_COMPOSE);
  assert.equal(sent[1].network, "deplo-preview-shop__pr-7");
  assert.equal((await appRow()).compose, PROD_STACK);
});

test("a fork's stack pulls with no registry credential of the team", async () => {
  await seedRegistry();
  await db
    .update(appPreviews)
    .set({
      isFork: true,
      headCloneUrl: "https://github.com/mallory/shop.git",
      approvedSha: SHA,
    })
    .where(eq(appPreviews.id, "prv_1"));
  answer = stackLegs;
  await runDeploymentGuarded("dpl_1");
  assert.equal((await depRow()).status, "ready");
  assert.equal(sent.length, 2);
  assert.equal(sent[1].git?.url, "https://github.com/mallory/shop.git");
  assert.deepEqual(sent[0].registryAuth, []);
  assert.deepEqual(sent[1].registryAuth, []);
});
