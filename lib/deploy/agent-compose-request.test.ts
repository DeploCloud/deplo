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
 * A multi-service compose stack deploys to a REMOTE server through the agent
 * (Part C). buildDeployRequest is the wire contract: the agent dispatches on
 * source_kind, writes env to a --env-file (the compose interpolates `${VAR}` —
 * NOT a baked `environment:` map like the single-image path), and materialises
 * the mount files. These assertions pin that mapping so the agent's COMPOSE case
 * keeps matching what the control plane sends.
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
 * buildDeployRequest must map them to the matching heavy BuildKind + a BuildSpec
 * (NOT BUILD_KIND_DOCKERFILE + a dockerfile descriptor) so the agent dispatches to
 * the ported builder. The git arm can't probe the tree, so it
 * keys purely off the method — these pin that mapping.
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
  assert.equal(req.dockerfile, undefined, "heavy method does not send a dockerfile descriptor");
  assert.equal(req.buildSpec?.method, "nixpacks");
  assert.equal(req.buildSpec?.installCommand, "npm ci");
  // Unpinned Nixpacks/Railpack default to a current Node major (see buildSpecFor).
  assert.equal(req.buildSpec?.runtimeVersion, "24");
  assert.equal(req.buildSpec?.runtimeLanguage, "node");
});

/**
 * Build-time env parity: when the control plane renders a GENERATED Dockerfile
 * (legacy/auto method, tree not probeable here), the resolved env-var NAMES must
 * ride into the body as ARG/ENV declarations — the agent then feeds the values
 * as build args, so build-time-inlined config (NEXT_PUBLIC_*) works. Values must
 * never appear in the body (it crosses the wire and lands on disk as text).
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
  assert.ok(!body.includes("secret"), "env VALUE must not be baked into the Dockerfile");
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
