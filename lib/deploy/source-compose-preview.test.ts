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
const PROD_STACK = "services:\n  web:\n    image: deplo/shop-web:prod\n";
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
