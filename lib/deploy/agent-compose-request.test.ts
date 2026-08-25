import { test } from "node:test";
import assert from "node:assert/strict";

import { buildDeployRequest } from "./agent-deploy";
import { SourceKind, BuildKind } from "../agent/gen/agent";
import type { BuildConfig } from "../types";

function baseBuild(overrides: Partial<BuildConfig> = {}): BuildConfig {
  return {
    buildMethod: "dockerfile",
    methodSettings: {},
    rootDirectory: "",
    includeFilesOutsideRoot: true,
    skipUnchangedDeployments: false,
    buildCache: true,
    buildCacheClearPending: false,
    installCommand: "",
    buildCommand: "",
    outputDirectory: "",
    startCommand: "",
    runtimeVersion: "",
    port: 3000,
    ...overrides,
  };
}

/**
 * A multi-service compose stack deploys to a REMOTE server through the agent (Part
 * C).
 */

const base = {
  deployId: "dep_1",
  slug: "myapp",
  appId: "proj_1",
  imageRef: "",
  composeYaml: "services:\n  web:\n    image: nginx\n",
  env: { API_KEY: "secret", PORT: "8080" },
};

test("compose plan → SOURCE_KIND_COMPOSE, no build, no pull", async () => {
  const req = await buildDeployRequest({
    ...base,
    plan: { kind: "compose", mounts: [] },
  });
  assert.equal(req.sourceKind, SourceKind.SOURCE_KIND_COMPOSE);
  assert.equal(req.buildKind, BuildKind.BUILD_KIND_NONE);
  assert.equal(req.pullImage, false);
  // No build context is tarred for a compose stack.
  assert.equal(req.contextTar.length, 0);
});

test("compose plan carries the rendered YAML and the decrypted env for the --env-file", async () => {
  const req = await buildDeployRequest({
    ...base,
    plan: { kind: "compose", mounts: [] },
  });
  assert.equal(req.composeYaml, base.composeYaml);
  // The env rides separately (the agent writes it to a 0600 env-file); it is NOT
  // expected to be inlined into the compose YAML for the multi-service path.
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

/**
 * Heavy build methods (static/nixpacks/buildpacks/railpack) now run agent-side.
 */

test("git plan with a heavy method → its BuildKind + a BuildSpec, no dockerfile", async () => {
  const req = await buildDeployRequest({
    ...base,
    plan: {
      kind: "git",
      url: "https://x@github.com/o/r.git",
      branch: "main",
      subdir: "",
      build: baseBuild({ buildMethod: "nixpacks", installCommand: "npm ci" }),
    },
  });
  assert.equal(req.sourceKind, SourceKind.SOURCE_KIND_GIT);
  assert.equal(req.buildKind, BuildKind.BUILD_KIND_NIXPACKS);
  assert.equal(
    req.dockerfile,
    undefined,
    "heavy method does not send a dockerfile descriptor",
  );
  assert.equal(req.buildSpec?.method, "nixpacks");
  assert.equal(req.buildSpec?.installCommand, "npm ci");
  // Unpinned Nixpacks/Railpack default to a current Node major (see buildSpecFor).
  assert.equal(req.buildSpec?.runtimeVersion, "24");
  assert.equal(req.buildSpec?.runtimeLanguage, "node");
});

/**
 * Build-time env parity: when the control plane renders a GENERATED Dockerfile
 * (legacy/auto method, tree not probeable here), the resolved env-var NAMES must
 * ride into the body as ARG/ENV declarations — the agent then feeds the values as
 */
test("git plan with a legacy/auto method embeds the env NAMES (not values) in the generated Dockerfile", async () => {
  const req = await buildDeployRequest({
    ...base,
    plan: {
      kind: "git",
      url: "https://x@github.com/o/r.git",
      branch: "main",
      subdir: "",
      // A legacy method string outside today's union: not heavy, not
      // "dockerfile" → the generated-Dockerfile arm.
      build: baseBuild({ buildMethod: "auto" as BuildConfig["buildMethod"] }),
    },
  });
  assert.equal(req.buildKind, BuildKind.BUILD_KIND_DOCKERFILE);
  assert.equal(req.dockerfile?.generated, true);
  const body = req.dockerfile?.generatedDockerfile ?? "";
  assert.match(body, /ARG API_KEY\nENV API_KEY=\$API_KEY/);
  assert.match(body, /ARG PORT\nENV PORT=\$PORT/);
  assert.ok(
    !body.includes("secret"),
    "env VALUE must not be baked into the Dockerfile",
  );
});

test("git plan with the static method → BUILD_KIND_STATIC + a BuildSpec", async () => {
  const req = await buildDeployRequest({
    ...base,
    plan: {
      kind: "git",
      url: "https://x@github.com/o/r.git",
      branch: "main",
      subdir: "",
      build: baseBuild({
        buildMethod: "static",
        outputDirectory: "dist",
        methodSettings: { staticSinglePageApp: true },
      }),
    },
  });
  assert.equal(req.buildKind, BuildKind.BUILD_KIND_STATIC);
  assert.equal(req.buildSpec?.method, "static");
  assert.equal(req.buildSpec?.outputDirectory, "dist");
  assert.equal(req.buildSpec?.staticSinglePageApp, true);
});

/* ---- the two freshness switches ------------------------------------- */

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

  // "Rebuild container" on a compose stack: nothing to build, but the containers
  // must be replaced — the case `up -d` alone silently skips.
  const rebuilt = await buildDeployRequest({
    ...base,
    plan: { kind: "compose", mounts: [] },
    forceRecreate: true,
  });
  assert.equal(rebuilt.forceRecreate, true);
  assert.equal(rebuilt.noBuildCache, false);
});

/**
 * The IMAGE plan serves two opposite jobs, and `pull` is what tells them apart.
 */
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
  // Nothing is shipped to build from: the image already exists on that host.
  assert.equal(req.contextTar.length, 0);
  assert.equal(req.git, undefined);
  assert.equal(req.buildSpec, undefined);
});
