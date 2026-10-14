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
import { appPreviews } from "../db/schema/control-plane/deployments";
import { ContractVersion, type DeployRequest } from "../agent/gen/agent";
import { runDeploymentGuarded } from "./build/deploy-run";

const APPROVED = "a".repeat(40);
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
            agentVersion: "test",
            capabilities: ["deploy.network", "git.commit", "deploy.railpack"],
          });
        if (prop === "deploy")
          return async function* (req: DeployRequest) {
            sent.push(req);
            yield {
              seq: 1,
              result: { ready: true, error: "", commitSha: APPROVED },
            };
          };
        return async () => ({ ok: true, exists: false, yaml: "", error: "" });
      },
    },
  ) as unknown as AgentConnection;

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
  // The fork's branch lookup is unavailable (rate limited), which used to skip every check.
  globalThis.fetch = (async () =>
    new Response("rate limited", { status: 403 })) as typeof fetch;
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
    slug: "web",
    repo: {
      provider: "github",
      url: "https://github.com/acme/repo",
      repo: "acme/repo",
      branch: "main",
    },
  });
  await seedPreview(db, {
    id: "prv_1",
    appId: "prj_1",
    prNumber: 1,
    isFork: true,
    approvedAt: "2026-01-01T00:00:00.000Z",
  });
  await db
    .update(appPreviews)
    .set({
      headCloneUrl: "https://github.com/someone/repo.git",
      approvedSha: APPROVED,
    })
    .where(eq(appPreviews.id, "prv_1"));
  await seedDeployment(db, {
    id: "dpl_1",
    appId: "prj_1",
    status: "queued",
    previewId: "prv_1",
    prNumber: 1,
    deployKey: "web__pr-1",
  });
});

test("a fork preview builds the approved commit, not the branch tip", async () => {
  await runDeploymentGuarded("dpl_1");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].git?.url, "https://github.com/someone/repo.git");
  assert.equal(sent[0].git?.commit, APPROVED);
});

test("a fork preview with no approved commit never reaches the agent", async () => {
  await db
    .update(appPreviews)
    .set({ approvedSha: null })
    .where(eq(appPreviews.id, "prv_1"));
  await runDeploymentGuarded("dpl_1");
  assert.equal(sent.length, 0);
});
