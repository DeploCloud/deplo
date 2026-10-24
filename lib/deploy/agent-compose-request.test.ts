import { test } from "node:test";
import assert from "node:assert/strict";

import { buildDeployRequest } from "./agent-deploy";
import { SourceKind, BuildKind } from "../agent/gen/agent";
import type { BuildConfig } from "../types/build";

function baseBuild(overrides: Partial<BuildConfig> = {}): BuildConfig {
  return {
    buildMethod: "dockerfile",
    methodAuto: false,
    methodSettings: {},
    rootDirectory: "",
    includeFilesOutsideRoot: true,
    skipUnchangedDeployments: false,
    buildCache: true,
    buildCacheClearPending: false,
    installCommand: null,
    buildCommand: null,
    outputDirectory: null,
    startCommand: null,
    runtimeVersion: "",
    port: 3000,
    ...overrides,
  };
}

const base = {
  deployId: "dep_1",
  slug: "myapp",
  appId: "proj_1",
  imageRef: "",
  composeYaml: "services:\n  web:\n    image: nginx\n",
  network: "deplo-team-team_test",
  env: { API_KEY: "secret", PORT: "8080" },
};

test("compose plan → SOURCE_KIND_COMPOSE, no build, no single image to pull", async () => {
  const req = await buildDeployRequest({
    ...base,
    plan: { kind: "compose", mounts: [] },
  });
  assert.equal(req.sourceKind, SourceKind.SOURCE_KIND_COMPOSE);
  assert.equal(req.buildKind, BuildKind.BUILD_KIND_NONE);
  assert.equal(req.pullImage, false);
  assert.equal(req.contextTar.length, 0);
});

test("a compose stack's bring-up pulls every service's image, the operator's flags after", async () => {
  const plain = await buildDeployRequest({
    ...base,
    plan: { kind: "compose", mounts: [] },
  });
  assert.deepEqual(plain.composeUpArgs, ["--pull", "always"]);
  const withFlags = await buildDeployRequest({
    ...base,
    plan: { kind: "compose", mounts: [] },
    composeUpArgs: ["--wait"],
  });
  assert.deepEqual(withFlags.composeUpArgs, ["--pull", "always", "--wait"]);
  const optedOut = await buildDeployRequest({
    ...base,
    plan: { kind: "compose", mounts: [] },
    composeUpArgs: ["--pull", "missing"],
  });
  assert.deepEqual(optedOut.composeUpArgs, ["--pull", "missing"]);
});

test("a single image is pulled or built BEFORE the bring-up, so its command stays bare", async () => {
  const built = await buildDeployRequest({
    ...base,
    imageRef: "deplo/myapp:abc123",
    plan: { kind: "image", image: "deplo/myapp:abc123", pull: false },
    composeUpArgs: ["--wait"],
  });
  assert.deepEqual(built.composeUpArgs, ["--wait"]);
  const pulled = await buildDeployRequest({
    ...base,
    imageRef: "nginx:latest",
    plan: { kind: "image", image: "nginx:latest", pull: true },
  });
  assert.equal(pulled.pullImage, true);
  assert.deepEqual(pulled.composeUpArgs, []);
});

test("compose plan carries the rendered YAML and the decrypted env for the --env-file", async () => {
  const req = await buildDeployRequest({
    ...base,
    plan: { kind: "compose", mounts: [] },
  });
  assert.equal(req.composeYaml, base.composeYaml);
  assert.deepEqual(req.env, base.env);
});

test("compose plan maps project mounts to MountFile{path, content}", async () => {
  const req = await buildDeployRequest({
    ...base,
    plan: {
      kind: "compose",
      mounts: [
        { filePath: "config.yml", content: "a: 1" },
        { filePath: "nested/app.conf", content: "key=val" },
      ],
    },
  });
  assert.deepEqual(req.mounts, [
    { path: "config.yml", content: "a: 1" },
    { path: "nested/app.conf", content: "key=val" },
  ]);
});

test("compose plan with no mounts sends an empty mounts list", async () => {
  const req = await buildDeployRequest({
    ...base,
    plan: { kind: "compose", mounts: [] },
  });
  assert.deepEqual(req.mounts, []);
});

const gitOf = (build: BuildConfig) => ({
  kind: "git" as const,
  url: "https://x@github.com/o/r.git",
  branch: "main",
  subdir: "",
  build,
});

test("git plan with Railpack → BUILD_KIND_RAILPACK + a BuildSpec, no dockerfile", async () => {
  const req = await buildDeployRequest({
    ...base,
    plan: gitOf(
      baseBuild({ buildMethod: "railpack", installCommand: "npm ci" }),
    ),
  });
  assert.equal(req.sourceKind, SourceKind.SOURCE_KIND_GIT);
  assert.equal(req.buildKind, BuildKind.BUILD_KIND_RAILPACK);
  assert.equal(req.dockerfile, undefined);
  assert.equal(req.buildSpec?.method, "railpack");
  assert.equal(req.buildSpec?.installCommand, "npm ci");
  assert.equal(req.buildSpec?.autoMethod, false);
  // Railpack picks its own Node unless the app pins one.
  assert.equal(req.buildSpec?.runtimeVersion, "");
  assert.equal(req.buildSpec?.runtimeLanguage, "");
});

test("Detect automatically asks the agent to prefer the repository's Dockerfile or compose file", async () => {
  const req = await buildDeployRequest({
    ...base,
    plan: gitOf(
      baseBuild({
        buildMethod: "railpack",
        methodAuto: true,
        methodSettings: { composeFile: "deploy/compose.yaml" },
      }),
    ),
  });
  assert.equal(req.buildKind, BuildKind.BUILD_KIND_RAILPACK);
  assert.equal(req.buildSpec?.autoMethod, true);
  assert.equal(req.buildSpec?.method, "auto");
  assert.equal(req.buildSpec?.composeFile, "deploy/compose.yaml");
});

test("an explicit Dockerfile wins even when the last auto deploy resolved something else", async () => {
  const req = await buildDeployRequest({
    ...base,
    plan: gitOf(
      baseBuild({
        buildMethod: "dockerfile",
        methodSettings: {
          dockerfilePath: "ops/Dockerfile",
          dockerBuildStage: "prod",
        },
      }),
    ),
  });
  assert.equal(req.buildKind, BuildKind.BUILD_KIND_DOCKERFILE);
  assert.equal(req.dockerfile?.dockerfilePath, "ops/Dockerfile");
  assert.equal(req.dockerfile?.targetStage, "prod");
  assert.equal(req.dockerfile?.generated, false);
});

test("an explicit compose method first only reads the file (BUILD_KIND_COMPOSE, empty stack)", async () => {
  const req = await buildDeployRequest({
    ...base,
    composeYaml: "",
    plan: gitOf(
      baseBuild({
        buildMethod: "compose",
        methodSettings: { composeFile: "docker-compose.prod.yml" },
      }),
    ),
  });
  assert.equal(req.sourceKind, SourceKind.SOURCE_KIND_GIT);
  assert.equal(req.buildKind, BuildKind.BUILD_KIND_COMPOSE);
  assert.equal(req.composeYaml, "");
  assert.equal(req.buildSpec?.composeFile, "docker-compose.prod.yml");
});

test("the compose leg deploys the rendered stack from the commit it was read at", async () => {
  const req = await buildDeployRequest({
    ...base,
    plan: {
      kind: "source-compose",
      source: {
        kind: "git",
        url: "https://x@github.com/o/r.git",
        commit: "a".repeat(40),
        subdir: "apps/web",
      },
      composeFile: "compose.yaml",
    },
  });
  assert.equal(req.sourceKind, SourceKind.SOURCE_KIND_GIT);
  assert.equal(req.buildKind, BuildKind.BUILD_KIND_COMPOSE);
  assert.equal(req.composeYaml, base.composeYaml);
  assert.equal(req.git?.commit, "a".repeat(40));
  assert.equal(req.git?.subdir, "apps/web");
  assert.equal(req.buildSpec?.method, "compose");
  assert.equal(req.buildSpec?.composeFile, "compose.yaml");
  assert.deepEqual(req.composeUpArgs, ["--pull", "always"]);
});

test("a static site is a Railpack build with its output folder", async () => {
  const req = await buildDeployRequest({
    ...base,
    plan: gitOf(
      baseBuild({
        buildMethod: "railpack",
        outputDirectory: "dist",
        methodSettings: { staticSinglePageApp: true },
      }),
    ),
  });
  assert.equal(req.buildKind, BuildKind.BUILD_KIND_RAILPACK);
  assert.equal(req.buildSpec?.outputDirectory, "dist");
  assert.equal(req.buildSpec?.staticSinglePageApp, true);
});

const gitPlan = {
  kind: "git" as const,
  url: "https://x@github.com/o/r.git",
  branch: "main",
  subdir: "",
  build: baseBuild(),
};

test("an ordinary deploy asks for neither a cache-less build nor a recreate", async () => {
  const req = await buildDeployRequest({ ...base, plan: gitPlan });
  assert.equal(req.noBuildCache, false);
  assert.equal(req.forceRecreate, false);
});

test("no-cache and force-recreate ride the request independently", async () => {
  const fresh = await buildDeployRequest({
    ...base,
    plan: gitPlan,
    noCache: true,
  });
  assert.equal(fresh.noBuildCache, true);
  assert.equal(fresh.forceRecreate, false);

  const rebuilt = await buildDeployRequest({
    ...base,
    plan: { kind: "compose", mounts: [] },
    forceRecreate: true,
  });
  assert.equal(rebuilt.forceRecreate, true);
  assert.equal(rebuilt.noBuildCache, false);
});

test("a prebuilt docker-image source PULLS its registry ref", async () => {
  const req = await buildDeployRequest({
    ...base,
    imageRef: "ghcr.io/acme/api:1.4.2",
    plan: { kind: "image", image: "ghcr.io/acme/api:1.4.2", pull: true },
  });
  assert.equal(req.sourceKind, SourceKind.SOURCE_KIND_IMAGE);
  assert.equal(req.buildKind, BuildKind.BUILD_KIND_NONE);
  assert.equal(req.pullImage, true);
  assert.equal(req.imageRef, "ghcr.io/acme/api:1.4.2");
});

test("a ROLLBACK runs the host's own image with no build and no pull", async () => {
  const req = await buildDeployRequest({
    ...base,
    imageRef: "deplo/myapp:dpl_abc123",
    plan: { kind: "image", image: "deplo/myapp:dpl_abc123", pull: false },
  });
  assert.equal(req.sourceKind, SourceKind.SOURCE_KIND_IMAGE);
  assert.equal(req.buildKind, BuildKind.BUILD_KIND_NONE);
  assert.equal(req.pullImage, false);
  assert.equal(req.imageRef, "deplo/myapp:dpl_abc123");
  assert.equal(req.contextTar.length, 0);
  assert.equal(req.git, undefined);
  assert.equal(req.buildSpec, undefined);
});
