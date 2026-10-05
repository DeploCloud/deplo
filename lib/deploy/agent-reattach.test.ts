import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import type { PGlite } from "@electric-sql/pglite";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { seedServer, SERVER_1 } from "../data/app-graph-test-helpers";
import { __setAgentConnectorForTest } from "../infra/agent-client/connect";
import type { AgentConnection } from "../infra/agent-client/connection";
import { runAgentDeploy } from "./agent-deploy";

let db: TestDb;
let pg: PGlite;
let dials = 0;
let reattaches = 0;

const helloOk = async () => ({
  contractVersion: 1,
  dockerAvailable: true,
  agentVersion: "test",
  capabilities: ["deploy.build-only"],
});

// The preflight and the first stream reach the agent; then it goes dark.
const fakeAgent = () => {
  dials++;
  const alive = dials <= 2;
  return {
    hello: alive
      ? helloOk
      : async () => {
          throw new Error("4 DEADLINE_EXCEEDED: Waiting for LB pick");
        },
    deploy: async function* () {
      yield { log: { level: "info", text: "building" }, seq: 1 };
      throw new Error("14 UNAVAILABLE: Connection dropped");
    },
    reattach: async function* () {
      reattaches++;
    },
    close: () => {},
  } as unknown as AgentConnection;
};

describe("reattaching to a deploy whose agent went dark", () => {
  before(async () => {
    ({ db, pg } = await makeTestDb());
    __setTestDb(db);
    await seedServer(db);
    __setAgentConnectorForTest(async () => fakeAgent());
  });

  after(async () => {
    __setAgentConnectorForTest();
    __resetTestDb();
    await pg.close();
  });

  test("gives up on Hello instead of opening a stream that waits out its deadline", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let done = false;
    const run = runAgentDeploy({
      serverId: SERVER_1,
      deployId: "dpl_dark",
      slug: "web",
      appId: "prj_1",
      imageRef: "deplo/web:dpl_dark",
      composeYaml: "services:\n  web:\n    image: deplo/web:dpl_dark\n",
      network: "deplo-team-team_a",
      env: {},
      plan: { kind: "image", image: "nginx", pull: true },
      buildOnly: true,
      sink: { log: () => {} },
    }).finally(() => (done = true));
    while (!done) {
      await new Promise((r) => setImmediate(r));
      t.mock.timers.tick(1_000);
    }
    assert.deepEqual(await run, { ready: false, commitSha: "" });
    assert.equal(reattaches, 0);
  });
});
