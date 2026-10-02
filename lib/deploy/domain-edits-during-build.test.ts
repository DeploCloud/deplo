import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { apps as appsTable } from "../db/schema/control-plane/apps";
import { domains as domainsTable } from "../db/schema/control-plane/domains";
import { seedIdentity, TEAM_A, USER_1 } from "../data/identity-test-helpers";
import {
  seedApp,
  seedDeployment,
  seedServer,
  TRUNCATE_PROJECT_GRAPH,
} from "../data/app-graph-test-helpers";
import { __setAgentConnectorForTest } from "../infra/agent-client/connect";
import type { AgentConnection } from "../infra/agent-client/connection";
import { routableForDeploy } from "./build/deploy-routes";
import { applyDomainEditsMadeDuringBuild } from "./build/domain-edits-during-build";
import { runWithIdentity } from "../auth/request-context";
import { reloadApp } from "../data/deployments/stack-actions";

let db: TestDb;
let pg: PGlite;
let calls: string[] = [];

function fakeAgent(): AgentConnection {
  return {
    hello: async () => ({
      contractVersion: 1,
      dockerAvailable: true,
      agentVersion: "test",
      capabilities: ["deploy.compose.multi", "deploy.network"],
    }),
    readStack: async () => ({ exists: true, yaml: "services: {}\n" }),
    reroute: async () => {
      calls.push("reroute");
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
  calls = [];
  await pg.exec(`${TRUNCATE_PROJECT_GRAPH}
    truncate table users, teams restart identity cascade;`);
  await seedIdentity(db, {
    users: [{ id: USER_1, teamId: TEAM_A, role: "owner" }],
  });
  await seedServer(db);
  await seedApp(db, {
    id: "app_1",
    slug: "app-1",
    source: "compose",
    status: "active",
    compose: "services:\n  web:\n    image: nginx\n",
  });
  await db.insert(domainsTable).values({
    id: "dom_1",
    appId: "app_1",
    name: "old.example.com",
    status: "valid",
    isPrimary: true,
    ssl: true,
    source: "custom",
    service: "web",
    port: 80,
    certProvider: "letsencrypt",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  await db
    .update(appsTable)
    .set({ productionUrl: "https://old.example.com" })
    .where(eq(appsTable.id, "app_1"));
});

const builtRoutes = () =>
  routableForDeploy("app_1", "production", "old.example.com");

const renameDomain = () =>
  db
    .update(domainsTable)
    .set({ name: "new.example.com" })
    .where(eq(domainsTable.id, "dom_1"));

async function productionUrl(): Promise<string | null> {
  const [row] = await db
    .select({ url: appsTable.productionUrl })
    .from(appsTable)
    .where(eq(appsTable.id, "app_1"));
  return row?.url ?? null;
}

test("a domain renamed during the build is routed once it finishes", async () => {
  const routes = await builtRoutes();
  await renameDomain();
  await seedDeployment(db, { id: "dpl_1", appId: "app_1", status: "ready" });
  await applyDomainEditsMadeDuringBuild("dpl_1", "app_1", routes);
  assert.deepEqual(calls, ["reroute"]);
  assert.equal(await productionUrl(), "https://new.example.com");
});

test("a build that saw no domain edit leaves the routing alone", async () => {
  const routes = await builtRoutes();
  await seedDeployment(db, { id: "dpl_1", appId: "app_1", status: "ready" });
  await applyDomainEditsMadeDuringBuild("dpl_1", "app_1", routes);
  assert.deepEqual(calls, []);
  assert.equal(await productionUrl(), "https://old.example.com");
});

test("a failed build applies nothing", async () => {
  const routes = await builtRoutes();
  await renameDomain();
  await seedDeployment(db, { id: "dpl_1", appId: "app_1", status: "error" });
  await applyDomainEditsMadeDuringBuild("dpl_1", "app_1", routes);
  assert.deepEqual(calls, []);
  assert.equal(await productionUrl(), "https://old.example.com");
});

test("Reload puts a stale app link back on the current domain", async () => {
  await renameDomain();
  const result = await runWithIdentity({ userId: USER_1, teamId: TEAM_A }, () =>
    reloadApp("app_1"),
  );
  assert.equal(result, "rerouted");
  assert.equal(await productionUrl(), "https://new.example.com");
});
