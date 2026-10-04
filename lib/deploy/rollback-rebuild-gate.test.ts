import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { PGlite } from "@electric-sql/pglite";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { seedServer, SERVER_1 } from "../data/app-graph-test-helpers";
import { __setAgentConnectorForTest } from "../infra/agent-client/connect";
import type { AgentConnection } from "../infra/agent-client/connection";
import type { DeployRequest } from "../agent/gen/agent";
import { runAgentDeploy } from "./agent-deploy";

const SHA = "a".repeat(40);
let capabilities: string[] = [];
let sent: DeployRequest[] = [];
let db: TestDb;
let pg: PGlite;

const fakeAgent = () =>
  ({
    hello: async () => ({
      contractVersion: 1,
      dockerAvailable: true,
      agentVersion: "test",
      capabilities,
    }),
    deploy: async function* (req: DeployRequest) {
      sent.push(req);
      yield { result: { ready: true, error: "", commitSha: SHA }, seq: 1 };
    },
    close: () => {},
  }) as unknown as AgentConnection;

const deploy = (commit?: string) =>
  runAgentDeploy({
    serverId: SERVER_1,
    deployId: "dpl_rb",
    slug: "web",
    appId: "prj_1",
    imageRef: "deplo/web:dpl_rb",
    composeYaml: "services:\n  web:\n    image: deplo/web:dpl_rb\n",
    network: "deplo-team-team_a",
    env: {},
    plan: {
      kind: "git",
      url: "https://example.com/acme/web.git",
      branch: "main",
      commit,
      subdir: "",
      build: { buildMethod: "dockerfile" } as never,
    },
    sink: { log: () => {} },
  });

describe("a rollback that rebuilds a commit", () => {
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
    sent = [];
    await pg.exec(`truncate table servers restart identity cascade;`);
    await seedServer(db);
  });

  test("an agent without git.commit is refused before it can build the branch tip", async () => {
    capabilities = ["deploy.dockerfile"];
    await assert.rejects(() => deploy(SHA), /too old to rebuild an earlier/);
    assert.equal(sent.length, 0);
  });

  test("an agent with git.commit is sent the commit to build", async () => {
    capabilities = ["deploy.dockerfile", "git.commit"];
    await deploy(SHA);
    assert.equal(sent[0]?.git?.commit, SHA);
  });

  test("an ordinary deploy sends no commit and needs no new agent", async () => {
    capabilities = ["deploy.dockerfile"];
    await deploy();
    assert.equal(sent[0]?.git?.commit, "");
  });
});
