import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { signState } from "../crypto";
import { validateRepoAnalysis } from "./deplopack";
import { detectionKey } from "./deplopack-types";
import { buildDeployRequest } from "../deploy/agent-deploy";
import { SourceKind, HelloResponse, ContractVersion } from "../agent/gen/agent";
import { usesComposeStack } from "../utils";
import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { seedIdentity, TEAM_A, USER_1 } from "../data/identity-test-helpers";
import { seedServer, seedApp } from "../data/app-graph-test-helpers";
import { apps } from "../db/schema/control-plane/apps";
import { loadAppGraph } from "../data/app-graph-load";
import { eq } from "drizzle-orm";
import { assertRepositoryComposeSavable } from "../data/apps/source-guards";
import { __setAgentConnectorForTest } from "../infra/agent-client/connect";
import type { AgentConnection } from "../infra/agent-client/connection";
import { readGitCompose } from "./repo-compose";
import { lintCompose, needsHostAccess } from "../deploy/compose-lint/lint";
import { composeHostReach } from "../deploy/compose-lint/host-privileges";

let database: Awaited<ReturnType<typeof makeTestDb>>;
let db: TestDb;
before(async () => {
  database = await makeTestDb();
  db = database.db;
  __setTestDb(db);
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner", isInstanceAdmin: false },
    ],
  });
  await seedServer(db);
});
after(async () => {
  __setAgentConnectorForTest();
  __resetTestDb();
  await database.pg.close();
});

const input = {
  repo: "acme/app",
  branch: "main",
  serverId: "srv_test",
  rootDirectory: "app",
};
const candidate = { type: "compose", path: "deploy/compose.yml" };
const commit = "a".repeat(40);
function receipt(detection = candidate) {
  return signState(
    JSON.stringify({
      success: true,
      purpose: "deplopack-analysis",
      teamId: "team",
      userId: "user",
      binding: {
        repo: input.repo,
        branch: input.branch,
        installationId: null,
        connectionId: null,
        serverId: input.serverId,
        buildServerId: null,
        rootDirectory: "app",
      },
      commitSha: commit,
      version: "0.1.0",
      detections: [detection],
    }),
    3600,
  );
}

test("a verified Compose selection preserves its Git path and has no Deplopack configuration", () => {
  const selected = validateRepoAnalysis(
    receipt(),
    detectionKey(candidate),
    [],
    input,
    "team",
    "user",
  );
  assert.equal(selected.composePath, candidate.path);
  assert.equal(selected.commitSha, commit);
  assert.deepEqual(selected.build.methodSettings, {});
  assert.deepEqual(selected.build.deplopackInputs, []);
  assert.equal(selected.build.rootDirectory, undefined);
  assert.throws(() =>
    validateRepoAnalysis(
      receipt(),
      detectionKey(candidate),
      [],
      { ...input, serverId: "other" },
      "team",
      "user",
    ),
  );
  assert.throws(() =>
    validateRepoAnalysis(
      receipt(),
      detectionKey(candidate),
      [],
      input,
      "other",
      "user",
    ),
  );
  assert.throws(() =>
    validateRepoAnalysis(
      receipt(),
      detectionKey(candidate),
      [],
      input,
      "team",
      "other",
    ),
  );
});

test("a Compose selection cannot substitute an unverified or escaping path", () => {
  assert.throws(() =>
    validateRepoAnalysis(
      receipt(),
      detectionKey({ ...candidate, path: "other.yml" }),
      [],
      input,
      "team",
      "user",
    ),
  );
  const escaping = { type: "compose", path: "../compose.yml" };
  assert.throws(() =>
    validateRepoAnalysis(
      receipt(escaping),
      detectionKey(escaping),
      [],
      input,
      "team",
      "user",
    ),
  );
});

test("a repository Compose request preserves the pinned revision and stays on the Compose path", async () => {
  const git = {
    url: "https://example.com/app.git",
    token: "test-token",
    branch: "main",
    commit,
    subdir: "app",
  };
  const request = await buildDeployRequest({
    deployId: "dpl_test",
    slug: "app",
    appId: "prj_test",
    imageRef: "",
    composeYaml: "services: {}",
    network: "deplo-team-test",
    env: {},
    plan: { kind: "compose", mounts: [], git, composePath: candidate.path },
  });
  assert.equal(request.sourceKind, SourceKind.SOURCE_KIND_COMPOSE);
  assert.deepEqual(request.git, git);
  assert.equal(request.composePath, candidate.path);
  assert.equal(
    usesComposeStack({
      source: "github",
      compose: "services: {}",
      repo: {},
      dockerImage: null,
      composePath: candidate.path,
    }),
    true,
  );
  const manual = await buildDeployRequest({
    deployId: "dpl_test",
    slug: "app",
    appId: "prj_test",
    imageRef: "",
    composeYaml: "services: {}",
    network: "deplo-team-test",
    env: {},
    plan: { kind: "compose", mounts: [] },
  });
  assert.equal(manual.git, undefined);
  assert.equal(manual.composePath, "");
});

test("the nullable repository path round-trips without changing a manual Compose app", async () => {
  await seedApp(db, { id: "prj_repo_compose", teamId: TEAM_A });
  assert.equal((await loadAppGraph("prj_repo_compose"))?.composePath, null);
  await db
    .update(apps)
    .set({ composePath: "deploy/compose.yml" })
    .where(eq(apps.id, "prj_repo_compose"));
  assert.equal(
    (await loadAppGraph("prj_repo_compose"))?.composePath,
    "deploy/compose.yml",
  );
});

test("new Git revisions cannot add host privileges or public ports without a grant", async () => {
  await assertRepositoryComposeSavable(
    "services:\n  app: {build: .., env_file: ../app.env, volumes: ['../data:/data']}\n",
    USER_1,
  );
  await assert.rejects(
    assertRepositoryComposeSavable(
      "services:\n  app: {image: busybox, privileged: true}\n",
      USER_1,
    ),
    /authorized user/,
  );
  await assert.rejects(
    assertRepositoryComposeSavable(
      "services:\n  app: {image: busybox, ports: ['8080:80']}\n",
      USER_1,
    ),
    /authorized user/,
  );
});

test("an older agent is rejected before reading the repository", async () => {
  const connection = {
    hello: async () =>
      HelloResponse.fromPartial({
        contractVersion: ContractVersion.CONTRACT_VERSION_V1,
        capabilities: [],
      }),
    close() {},
  };
  __setAgentConnectorForTest(async () => connection as AgentConnection);
  try {
    await assert.rejects(
      readGitCompose(
        "srv_test",
        {
          provider: "github",
          url: "https://github.com/acme/app",
          repo: "acme/app",
          branch: "main",
        },
        "compose.yml",
        "",
        "main",
        commit,
      ),
      /Update the server agent/,
    );
  } finally {
    __setAgentConnectorForTest();
  }
});

test("repository-relative files stay isolated without requiring host access", () => {
  const yaml =
    "services:\n  app: {build: .., env_file: ../app.env, volumes: ['../data:/data']}\nconfigs:\n  config: {file: ../config.yml}\n";
  assert.equal(composeHostReach(yaml, true).length, 0);
  assert.equal(needsHostAccess(lintCompose(yaml, true)), false);
  assert.ok(composeHostReach(yaml).length > 0);
  assert.ok(
    composeHostReach("services:\n  app: {volumes: ['/etc:/data']}\n", true)
      .length > 0,
  );
});
