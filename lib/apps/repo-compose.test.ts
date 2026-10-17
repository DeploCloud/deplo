import type { DeployRequest, ReadRepoComposeRequest } from "../agent/gen/agent";
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

test("the actual wizard payload persists Git Compose with its selected root", async () => {
  const { buildCreateAppInput } =
    await import("../../components/apps/new-app-wizard/create-app");
  const { buildConfigFor } = await import("../frameworks");
  const { graphql } = await import("graphql");
  const { schema } = await import("../graphql/schema");
  const { runWithIdentity } = await import("../auth/request-context");
  const { getCurrentUser } = await import("../auth/current-user");
  const { reachableCapabilities } = await import("../membership");
  const { __setDnsLookupForTest, __resetDnsLookupForTest } =
    await import("../outbound-url");
  __setDnsLookupForTest(async () => [{ address: "140.82.112.3" }]);
  const reads: string[] = [];
  let compose = "";
  __setAgentConnectorForTest(
    async () =>
      ({
        hello: async () =>
          HelloResponse.fromPartial({
            contractVersion: ContractVersion.CONTRACT_VERSION_V1,
            capabilities: ["deploy.compose.git"],
          }),
        readRepoCompose: async (request: ReadRepoComposeRequest) => {
          assert.equal(request.source?.commit, commit);
          assert.equal(request.composePath, candidate.path);
          reads.push(request.source?.subdir ?? "");
          return { commitSha: commit, composeYaml: compose };
        },
        close() {},
      }) as unknown as AgentConnection,
  );
  try {
    let index = 0;
    for (const source of ["git", "github"] as const) {
      const root = index++ === 0 ? "" : "apps/api";
      compose = `services:\n  web${index}: {build: .}\n`;
      const analysisReceipt = signState(
        JSON.stringify({
          success: true,
          purpose: "deplopack-analysis",
          teamId: TEAM_A,
          userId: USER_1,
          binding: {
            repo: input.repo,
            branch: "main",
            installationId: null,
            connectionId: null,
            serverId: "srv_1",
            buildServerId: null,
            rootDirectory: root,
          },
          commitSha: commit,
          version: "0.1.0",
          detections: [candidate],
        }),
        3600,
      );
      const payload = buildCreateAppInput({
        analysisReceipt,
        deplopackCandidate: detectionKey(candidate),
        name: `wizard-${index}`,
        serverId: "srv_1",
        buildServerId: null,
        source,
        isTemplate: false,
        useCompose: true,
        templateCompose: false,
        compose: "untrusted client YAML",
        composeDiags: [],
        composeUpArgs: "",
        composeArgsProblem: null,
        ghSelection: {
          fullName: input.repo,
          branch: "main",
          installationId: "",
        },
        gitValue: {
          provider: "github",
          url: `https://github.com/${input.repo}`,
          repo: input.repo,
          branch: "main",
          connectionId: null,
        },
        dockerImage: "",
        gitOptions: { triggerType: "push", watchPaths: "", submodules: false },
        buildsImage: false,
        build: buildConfigFor({
          buildMethod: "dockerfile",
          rootDirectory: root,
        }),
        envRows: [],
        sharedIds: [],
        usesGit: true,
        autoDeploy: true,
        shouldDeploy: false,
        primaryService: null,
        routeCandidates: [],
        extraRouted: [],
      });
      assert.ok(payload);
      assert.equal(payload.source, source.toUpperCase());
      assert.equal(payload.compose, null);
      const execute = (variables: typeof payload) =>
        runWithIdentity({ userId: USER_1, teamId: TEAM_A }, async () =>
          graphql({
            schema,
            source:
              "mutation($input: CreateAppInput!) { createApp(input:$input) { id source composePath } }",
            variableValues: { input: variables },
            contextValue: {
              viewer: await getCurrentUser(),
              teamId: TEAM_A,
              capabilities: await reachableCapabilities(),
              via: "cookie",
              identity: null,
            },
          }),
        );
      const result = await execute(payload);
      assert.equal(result.errors, undefined, JSON.stringify(result.errors));
      const appId = (result.data?.createApp as { id: string }).id;
      const app = await loadAppGraph(appId);
      assert.equal(app?.source, source);
      assert.equal(app?.repo?.repo, input.repo);
      assert.equal(app?.repo?.branch, "main");
      assert.equal(app?.build.rootDirectory, root);
      assert.equal(app?.composePath, candidate.path);
      assert.equal(app?.compose, compose);
      assert.equal(app?.autoDeploy, true);
      const invalid = await execute({ ...payload, source: "COMPOSE", compose });
      assert.match(invalid.errors?.[0]?.message ?? "", /requires a Git source/);
    }
    assert.deepEqual(reads, ["", "apps/api"]);
  } finally {
    __setAgentConnectorForTest();
    __resetDnsLookupForTest();
  }
});

test("each Compose deploy uses the requested Git revision and preserves the applied snapshot on failure", async () => {
  const { deployComposeStackViaAgent } =
    await import("../deploy/build/compose-stack-deploy");
  const { seedDeployment } = await import("../data/app-graph-test-helpers");
  const { DeployEvent } = await import("../agent/gen/agent");
  const { dockerCleanupExcludedServers } =
    await import("../db/schema/control-plane/docker-cleanup");
  await db.insert(dockerCleanupExcludedServers).values({ serverId: "srv_1" });
  const id = "prj_compose_revisions";
  await seedApp(db, {
    id,
    slug: "compose-revisions",
    compose: "services: {old: {image: busybox}}",
    createdByUserId: USER_1,
  });
  await db
    .update(apps)
    .set({ composePath: "compose.yml" })
    .where(eq(apps.id, id));
  const app = (await loadAppGraph(id))!;
  const sent: DeployRequest[] = [];
  let ready = true;
  let failRead = false;
  const revisions: string[] = [];
  const yamlFor = (sha: string) =>
    `services:\n  revision: {build: {context: ./src-${sha[0]}, dockerfile: Dockerfile.${sha[0]}}}\n`;
  __setAgentConnectorForTest(
    async () =>
      ({
        hello: async () =>
          HelloResponse.fromPartial({
            contractVersion: ContractVersion.CONTRACT_VERSION_V1,
            dockerAvailable: true,
            capabilities: [
              "deploy.compose.git",
              "deploy.compose.multi",
              "deploy.network",
            ],
          }),
        readRepoCompose: async (request: ReadRepoComposeRequest) => {
          if (failRead) throw new Error("revision unavailable");
          const sha = request.source!.commit;
          revisions.push(sha);
          return { commitSha: sha, composeYaml: yamlFor(sha) };
        },
        deploy: async function* (request: DeployRequest) {
          sent.push(request);
          yield DeployEvent.fromPartial({
            seq: 1,
            result: {
              ready,
              commitSha: request.git!.commit,
              error: ready ? "" : "build failed",
            },
          });
        },
        close() {},
      }) as unknown as AgentConnection,
  );
  try {
    for (const letter of ["a", "b", "c", "d"]) {
      const sha = letter.repeat(40);
      const depId = `dpl_compose_revision_${letter}`;
      await seedDeployment(db, {
        id: depId,
        appId: id,
        commitSha: sha,
        status: "building",
      });
      await db
        .update(apps)
        .set({ latestDeploymentId: depId })
        .where(eq(apps.id, id));
      ready = letter !== "c";
      failRead = letter === "d";
      const deploying = deployComposeStackViaAgent({
        depId,
        project: app,
        serverId: app.serverId,
        name: `deplo-${app.slug}`,
        deployKey: app.slug,
        trackingId: id,
        target: {
          kind: "app",
          appId: id,
          teamId: TEAM_A,
          name: app.name,
          slug: app.slug,
        },
        preview: null,
        domain: "",
        domains: [],
        domainRoutes: [],
        environment: "production",
        started: Date.now(),
        forceRecreate: false,
        repository: { branch: "main", commit: sha },
      });
      if (failRead) await assert.rejects(deploying, /revision unavailable/);
      else {
        await deploying;
        assert.equal(sent.at(-1)?.git?.commit, sha);
        assert.match(
          sent.at(-1)?.composeYaml ?? "",
          new RegExp(`Dockerfile\\.${letter}`),
        );
      }
      const applied = await loadAppGraph(id);
      assert.equal(
        applied?.compose,
        yamlFor((letter === "a" ? "a" : "b").repeat(40)),
      );
    }
    assert.deepEqual(
      revisions,
      ["a", "b", "c"].map((letter) => letter.repeat(40)),
    );
    assert.equal(sent.length, 3);
  } finally {
    __setAgentConnectorForTest();
    await db
      .delete(dockerCleanupExcludedServers)
      .where(eq(dockerCleanupExcludedServers.serverId, "srv_1"));
  }
});
