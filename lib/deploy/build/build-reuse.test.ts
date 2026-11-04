import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../../db/test-harness";
import { __setTestDb, __resetTestDb } from "../../db/client";
import { deployments } from "../../db/schema/control-plane/deployments";
import {
  seedApp,
  seedDeployment,
  seedServer,
  SERVER_1,
  TRUNCATE_PROJECT_GRAPH,
} from "../../data/app-graph-test-helpers";
import { seedIdentity } from "../../data/identity-test-helpers";
import { __setAgentConnectorForTest } from "../../infra/agent-client/connect";
import type { AgentConnection } from "../../infra/agent-client/connection";
import {
  BuildKind,
  SourceKind,
  type DeployRequest,
} from "../../agent/gen/agent";
import { runAgentDeploy } from "../agent-deploy";
import { buildFingerprint, REUSE_IMAGE_CAPABILITY } from "./build-reuse";

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
      agentVersion: "9.9.9",
      capabilities,
    }),
    deploy: async function* (req: DeployRequest) {
      sent.push(req);
      yield { result: { ready: true, error: "", commitSha: SHA }, seq: 1 };
    },
    close: () => {},
  }) as unknown as AgentConnection;

const deploy = (
  depId: string,
  opts: { env?: Record<string, string>; forceRecreate?: boolean } = {},
) =>
  runAgentDeploy({
    serverId: SERVER_1,
    deployId: depId,
    slug: "web",
    appId: "prj_web",
    imageRef: `deplo/web:${depId}`,
    composeYaml: `services:\n  web:\n    image: deplo/web:${depId}\n`,
    network: "deplo-team-team_a",
    env: opts.env ?? { NEXT_PUBLIC_A: "1" },
    forceRecreate: opts.forceRecreate,
    plan: {
      kind: "git",
      url: "https://x-access-token:one@github.com/acme/web.git",
      branch: "main",
      subdir: "",
      build: { buildMethod: "dockerfile" } as never,
    },
    reuseFor: depId,
    sink: { log: () => {} },
  });

describe("a redeploy that reuses the image of the same commit", () => {
  before(async () => {
    ({ db, pg } = await makeTestDb());
    __setTestDb(db);
    await seedIdentity(db);
    __setAgentConnectorForTest(async () => fakeAgent());
  });

  after(async () => {
    __setAgentConnectorForTest();
    __resetTestDb();
    await pg.close();
  });

  beforeEach(async () => {
    sent = [];
    capabilities = ["deploy.dockerfile", REUSE_IMAGE_CAPABILITY];
    await pg.exec(TRUNCATE_PROJECT_GRAPH);
    await seedServer(db);
    await seedApp(db, { id: "prj_web", slug: "web" });
    for (const id of ["dpl_old", "dpl_new"])
      await seedDeployment(db, {
        id,
        appId: "prj_web",
        status: "building",
        serverId: SERVER_1,
        deployKey: "web",
      });
    await deploy("dpl_old");
    await db
      .update(deployments)
      .set({ status: "ready", imageRef: "deplo/web:dpl_old", commitSha: SHA })
      .where(eq(deployments.id, "dpl_old"));
  });

  test("the fingerprint ignores the commit, the URL's token and the order of variables", () => {
    const req = (over: Partial<DeployRequest>) =>
      ({
        sourceKind: SourceKind.SOURCE_KIND_GIT,
        buildKind: BuildKind.BUILD_KIND_RAILPACK,
        env: { A: "1", B: "2" },
        git: {
          url: "https://x-access-token:one@github.com/acme/web.git",
          branch: "main",
          commit: "",
          subdir: "",
          token: "",
          submodules: false,
        },
        ...over,
      }) as DeployRequest;
    const base = buildFingerprint(req({}));
    assert.equal(
      buildFingerprint(
        req({
          env: { B: "2", A: "1" },
          git: {
            ...req({}).git!,
            url: "https://x-access-token:two@github.com/acme/web.git",
            commit: SHA,
          },
        }),
      ),
      base,
    );
    assert.notEqual(buildFingerprint(req({ env: { A: "1", B: "3" } })), base);
    assert.notEqual(
      buildFingerprint(req({ git: { ...req({}).git!, branch: "dev" } })),
      base,
    );
  });

  test("the first build is offered nothing, the next one the live image of the same input", async () => {
    assert.equal(sent[0]?.reuseImage, undefined);
    await deploy("dpl_new");
    assert.deepEqual(sent[1]?.reuseImage, {
      imageRef: "deplo/web:dpl_old",
      commitSha: SHA,
    });
  });

  test("a changed build variable, a Rebuild or an older agent builds again", async () => {
    await deploy("dpl_new", { env: { NEXT_PUBLIC_A: "2" } });
    await deploy("dpl_new", { forceRecreate: true });
    capabilities = ["deploy.dockerfile"];
    await deploy("dpl_new");
    assert.deepEqual(
      sent.slice(1).map((r) => r.reuseImage),
      [undefined, undefined, undefined],
    );
  });
});
