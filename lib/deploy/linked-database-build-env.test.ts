import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { encryptSecret } from "../crypto";
import { __setAgentConnectorForTest } from "../infra/agent-client/connect";
import type { AgentConnection } from "../infra/agent-client/connection";
import { seedIdentity, TEAM_A, USER_1 } from "../data/identity-test-helpers";
import {
  seedApp,
  seedDeployment,
  seedServer,
  TRUNCATE_PROJECT_GRAPH,
} from "../data/app-graph-test-helpers";
import { insertEnvVars } from "../data/app-graph-load";
import { seedDatabase, settleProvisioning } from "../data/backup-test-helpers";
import { databases as databasesTable } from "../db/schema/control-plane/databases";
import { ContractVersion, type DeployRequest } from "../agent/gen/agent";
import { runDeploymentGuarded } from "./build/deploy-run";

const PRIVATE = "postgresql://app:pw@db-shop:5432/db-shop";
const PUBLIC = "postgresql://app:pw@203.0.113.10:15432/db-shop";
let db: TestDb;
let pg: PGlite;
let sent: DeployRequest[] = [];
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
            capabilities: ["deploy.network", "git.commit", "deploy.railpack"],
          });
        if (prop === "deploy")
          return async function* (req: DeployRequest) {
            sent.push(req);
            yield {
              seq: 1,
              result: { ready: true, error: "", commitSha: "a".repeat(40) },
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
    new Response("offline", { status: 403 })) as typeof fetch;
  __setAgentConnectorForTest(async () => fakeAgent());
});

after(async () => {
  globalThis.fetch = realFetch;
  __setAgentConnectorForTest();
  await settleProvisioning(db);
  __resetTestDb();
  await pg.close();
});

beforeEach(async () => {
  sent = [];
  await pg.exec(`${TRUNCATE_PROJECT_GRAPH}
    truncate table databases, users, teams restart identity cascade;`);
  await seedIdentity(db, {
    users: [{ id: USER_1, teamId: TEAM_A, role: "owner" }],
  });
  await seedServer(db);
  await seedApp(db, { id: "prj_1", teamId: TEAM_A, slug: "web" });
  await seedDatabase(db, { id: "db_shop", name: "shop" });
  await insertEnvVars(db as unknown as Parameters<typeof insertEnvVars>[0], [
    {
      id: "env_1",
      appId: "prj_1",
      key: "DATABASE_URL",
      valueEnc: encryptSecret(PRIVATE),
      targets: ["production"],
      type: "secret",
      databaseId: "db_shop",
      databaseUnlinked: false,
      createdByUserId: null,
      updatedByUserId: null,
      createdAt: "2026-10-28T00:00:00.000Z",
      updatedAt: "2026-10-28T00:00:00.000Z",
    },
  ]);
  await seedDeployment(db, { id: "dpl_1", appId: "prj_1", status: "queued" });
});

test("the build gets an exposed database's public address, the running app its private one", async () => {
  await db
    .update(databasesTable)
    .set({
      exposedPublicly: true,
      exposedPort: 15432,
      connectionStringEnc: encryptSecret(
        PUBLIC.replace(/^postgresql/, "postgres"),
      ),
    })
    .where(eq(databasesTable.id, "db_shop"));
  await runDeploymentGuarded("dpl_1");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].env.DATABASE_URL, PUBLIC);
  assert.ok(sent[0].composeYaml.includes(PRIVATE), sent[0].composeYaml);
  assert.ok(!sent[0].composeYaml.includes(PUBLIC));
});

test("a database that is not exposed stays private for the build too", async () => {
  await runDeploymentGuarded("dpl_1");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].env.DATABASE_URL, PRIVATE);
  assert.ok(sent[0].composeYaml.includes(PRIVATE));
});
