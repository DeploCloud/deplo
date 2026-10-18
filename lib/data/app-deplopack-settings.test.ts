import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { runWithIdentity } from "../auth/request-context";
import { seedIdentity, TEAM_A, TEAM_B, USER_1 } from "./identity-test-helpers";
import {
  seedServer,
  seedApp,
  TRUNCATE_PROJECT_GRAPH,
} from "./app-graph-test-helpers";
import { updateAppBuild } from "./apps/build-settings";
import { loadAppGraph } from "./app-graph-load";
import {
  appRepoAnalysisInput,
  analyzeAppRepo,
} from "../apps/app-repo-analysis";
import { detectionKey, type DeplopackDetection } from "../apps/deplopack-types";
import { signState } from "../crypto";
import { normalizeRootRel } from "../deploy/source";
import { apps } from "../db/schema/control-plane/apps";
import { __setAgentConnectorForTest } from "../infra/agent-client/connect";
import { HelloResponse } from "../agent/gen/agent";
import type { AgentConnection } from "../infra/agent-client/connection";
import {
  __setDnsLookupForTest,
  __resetDnsLookupForTest,
} from "../outbound-url";

let database: Awaited<ReturnType<typeof makeTestDb>>;
let db: TestDb;
before(async () => {
  database = await makeTestDb();
  db = database.db;
  __setTestDb(db);
});
after(async () => {
  __setAgentConnectorForTest();
  __resetDnsLookupForTest();
  __resetTestDb();
  await database.pg.close();
});
beforeEach(async () => {
  await database.pg.exec(
    TRUNCATE_PROJECT_GRAPH +
      " truncate table users, teams restart identity cascade;",
  );
  await seedIdentity(db, {
    users: [
      {
        id: USER_1,
        teamId: TEAM_A,
        role: "member",
        capabilities: ["view", "configure_apps"],
        isInstanceAdmin: false,
      },
      {
        id: "viewer",
        teamId: TEAM_A,
        role: "member",
        capabilities: ["view"],
        isInstanceAdmin: false,
      },
    ],
  });
  await seedServer(db);
  await seedApp(db, {
    id: "prj_beta",
    repo: {
      provider: "github",
      url: "https://github.com/acme/app",
      repo: "acme/app",
      branch: "main",
    },
  });
});
const asUser = <T>(fn: () => Promise<T>, userId = USER_1) =>
  runWithIdentity({ userId, teamId: TEAM_A }, fn);
const detection: DeplopackDetection = {
  type: "node",
  inputs: [
    {
      type: "text-list",
      env: "DEPLOPACK_BUILD_COMMANDS",
      label: "Build",
      description: "",
    },
  ],
};
const overrides = [
  {
    env: "DEPLOPACK_BUILD_COMMANDS",
    type: "text-list",
    values: ["bun run build"],
  },
];
async function selection(candidate = detection, userId = USER_1) {
  const app = await loadAppGraph("prj_beta");
  assert.ok(app);
  const input = appRepoAnalysisInput(app);
  return {
    receipt: signState(
      JSON.stringify({
        success: true,
        purpose: "deplopack-analysis",
        teamId: TEAM_A,
        userId,
        binding: {
          repo: input.repo,
          branch: input.branch,
          installationId: null,
          connectionId: null,
          serverId: input.serverId,
          buildServerId: null,
          rootDirectory: normalizeRootRel(input.rootDirectory),
        },
        commitSha: "a".repeat(40),
        version: "0.1.0",
        detections: [candidate],
      }),
      3600,
    ),
    candidate: detectionKey(candidate),
    inputs: candidate === detection ? overrides : [],
  };
}
test("switch to DeploPacks persists validated inputs and keeps legacy commands, ports and cache", async () => {
  await asUser(() =>
    updateAppBuild("prj_beta", {
      buildCommand: "npm run custom",
      port: 8080,
      buildCache: false,
      methodSettings: { railpackVersion: "0.8.0" },
    }),
  );
  const selected = await selection();
  await asUser(() =>
    updateAppBuild(
      "prj_beta",
      {
        buildMethod: "deplopack",
        methodSettings: { deplopackVersion: "99.0.0" },
      },
      selected,
    ),
  );
  const app = await loadAppGraph("prj_beta");
  assert.equal(app?.build.buildMethod, "deplopack");
  assert.equal(app?.build.methodSettings.deplopackVersion, "0.1.0");
  assert.equal(app?.build.methodSettings.deplopackProvider, "node");
  assert.equal(app?.build.methodSettings.railpackVersion, "0.8.0");
  assert.deepEqual(app?.build.deplopackInputs, overrides);
  assert.equal(app?.build.port, 8080);
  assert.equal(app?.build.buildCache, false);
  assert.equal(app?.build.buildCommand, "npm run custom");
  assert.ok(app?.pendingChangesAt);
  await asUser(() => updateAppBuild("prj_beta", { buildMethod: "railpack" }));
  assert.equal((await loadAppGraph("prj_beta"))?.build.buildMethod, "railpack");
});
test("missing, tampered, wrong-user and stale receipts leave the old builder untouched", async () => {
  const selected = await selection();
  for (const invalid of [
    {},
    { ...selected, receipt: "tampered" },
    await selection(detection, "viewer"),
  ]) {
    await assert.rejects(
      asUser(() =>
        updateAppBuild("prj_beta", { buildMethod: "deplopack" }, invalid),
      ),
    );
  }
  await db
    .update(apps)
    .set({ repoBranch: "other" })
    .where(eq(apps.id, "prj_beta"));
  await assert.rejects(
    asUser(() =>
      updateAppBuild("prj_beta", { buildMethod: "deplopack" }, selected),
    ),
    /selection changed/,
  );
  assert.equal((await loadAppGraph("prj_beta"))?.build.buildMethod, "railpack");
});
test("Dockerfile and Compose detections cannot silently change the requested build method", async () => {
  for (const type of ["dockerfile", "compose"]) {
    const selected = await selection({
      type,
      path: type === "compose" ? "compose.yml" : "Dockerfile",
    });
    await assert.rejects(
      asUser(() =>
        updateAppBuild("prj_beta", { buildMethod: "deplopack" }, selected),
      ),
      /Select a DeploPacks/,
    );
  }
});
test("inputs are validated and cannot be changed without an analysis receipt", async () => {
  const selected = await selection();
  await assert.rejects(
    asUser(() =>
      updateAppBuild(
        "prj_beta",
        { buildMethod: "deplopack" },
        {
          ...selected,
          inputs: [
            { env: "DEPLOPACK_PROVIDER", type: "text", values: ["evil"] },
          ],
        },
      ),
    ),
  );
  await asUser(() =>
    updateAppBuild("prj_beta", { buildMethod: "deplopack" }, selected),
  );
  await assert.rejects(
    asUser(() => updateAppBuild("prj_beta", {}, { inputs: [] })),
    /Analyze the repository/,
  );
  await asUser(() => updateAppBuild("prj_beta", { port: 9090 }));
  assert.deepEqual(
    (await loadAppGraph("prj_beta"))?.build.deplopackInputs,
    overrides,
  );
});
test("a viewer and another team cannot configure or analyze this app", async () => {
  const selected = await selection();
  await assert.rejects(
    asUser(
      () => updateAppBuild("prj_beta", { buildMethod: "deplopack" }, selected),
      "viewer",
    ),
    /permission/,
  );
  await assert.rejects(
    asUser(() => analyzeAppRepo("prj_beta"), "viewer"),
    /permission/,
  );
  await seedApp(db, { id: "prj_other", teamId: TEAM_B });
  await assert.rejects(
    asUser(() => analyzeAppRepo("prj_other")),
    /App not found/,
  );
});
test("configure permission alone can analyze an existing app, filtering other build methods", async () => {
  __setDnsLookupForTest(async () => [{ address: "140.82.112.3" }]);
  __setAgentConnectorForTest(
    async () =>
      ({
        hello: async () =>
          HelloResponse.fromPartial({
            capabilities: ["repo.analyze.deplopack"],
          }),
        analyzeRepo: async () => ({
          commitSha: "a".repeat(40),
          detectorVersion: "0.1.0",
          result: {
            success: true,
            detections: [
              detection,
              { type: "dockerfile" },
              { type: "compose" },
            ],
          },
        }),
        close() {},
      }) as unknown as AgentConnection,
  );
  try {
    const result = await asUser(() => analyzeAppRepo("prj_beta"));
    assert.deepEqual(result.result.detections, [detection]);
    assert.ok(result.receipt);
  } finally {
    __setAgentConnectorForTest();
    __resetDnsLookupForTest();
  }
});
