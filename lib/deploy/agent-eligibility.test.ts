import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  agentCanHandle,
  agentCapabilityForMethod,
  buildSpecFor,
  explicitDockerfileDescriptor,
  findComposeFile,
  resolveUploadMethod,
} from "./agent-deploy";
import type { BuildConfig } from "../types/build";

function build(
  method: BuildConfig["buildMethod"],
  methodAuto = false,
): BuildConfig {
  return {
    buildMethod: method,
    methodAuto,
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
  };
}

test("image source (no build config) is agent-eligible and needs no builder capability", () => {
  assert.equal(agentCanHandle(null), true);
  assert.equal(agentCapabilityForMethod(null), null);
});

test("every build method is agent-eligible", () => {
  for (const m of ["dockerfile", "railpack", "compose"] as const)
    assert.equal(agentCanHandle(build(m)), true, `${m} is agent-eligible`);
});

test("each method names the agent capability it needs; Detect automatically needs Railpack", () => {
  assert.equal(agentCapabilityForMethod(build("dockerfile")), null);
  assert.equal(agentCapabilityForMethod(build("railpack")), "deploy.railpack");
  assert.equal(
    agentCapabilityForMethod(build("compose")),
    "deploy.compose.source",
  );
  // An auto app whose last deploy built a Dockerfile still falls back to Railpack on an old agent.
  assert.equal(
    agentCapabilityForMethod(build("dockerfile", true)),
    "deploy.railpack",
  );
});

test("a stored retired method reads as Railpack", () => {
  const legacy = {
    ...build("railpack"),
    buildMethod: "nixpacks",
  } as unknown as BuildConfig;
  assert.equal(agentCapabilityForMethod(legacy), "deploy.railpack");
  assert.equal(buildSpecFor(legacy).method, "railpack");
});

test("buildSpecFor flattens the build config", () => {
  const b = build("railpack");
  b.installCommand = "npm ci";
  b.buildCommand = "npm run build";
  b.startCommand = "node server.js";
  b.runtimeVersion = "20";
  b.outputDirectory = "dist";
  b.methodSettings = { staticSinglePageApp: true };
  const spec = buildSpecFor(b);
  assert.equal(spec.method, "railpack");
  assert.equal(spec.port, 3000);
  assert.equal(spec.installCommand, "npm ci");
  assert.equal(spec.buildCommand, "npm run build");
  assert.equal(spec.startCommand, "node server.js");
  assert.equal(spec.runtimeVersion, "20");
  assert.equal(spec.runtimeLanguage, "node");
  assert.equal(spec.outputDirectory, "dist");
  assert.equal(spec.staticSinglePageApp, true);
  assert.equal(spec.autoMethod, false);
});

test("buildSpecFor leaves the Node version to Railpack when the app pins none", () => {
  const spec = buildSpecFor(build("railpack"));
  assert.equal(spec.runtimeVersion, "");
  assert.equal(spec.runtimeLanguage, "");
});

test("an empty command means run nothing, null means let Railpack decide", () => {
  const b = build("railpack");
  assert.equal(buildSpecFor(b).skipBuild, true);
  b.buildCommand = null;
  b.installCommand = null;
  const spec = buildSpecFor(b);
  assert.equal(spec.skipBuild, false);
  assert.equal(spec.skipInstall, false);
});

test("explicit dockerfile descriptor carries methodSettings", () => {
  const b = build("dockerfile");
  b.methodSettings = {
    dockerfilePath: "docker/Dockerfile.prod",
    dockerContextPath: "app",
    dockerBuildStage: "production",
  };
  const d = explicitDockerfileDescriptor(b);
  assert.equal(d.dockerfilePath, "docker/Dockerfile.prod");
  assert.equal(d.contextPath, "app");
  assert.equal(d.targetStage, "production");
  assert.equal(d.generated, false, "an explicit Dockerfile is never generated");
});

test("explicit dockerfile descriptor defaults when unset", () => {
  const d = explicitDockerfileDescriptor(build("dockerfile"));
  assert.equal(d.dockerfilePath, "Dockerfile");
  assert.equal(d.contextPath, ".");
  assert.equal(d.targetStage, "");
  assert.equal(d.generated, false);
});

test("an upload on Detect automatically: Dockerfile, then a compose file, then Railpack", async () => {
  const dir = await mkdtemp(join(tmpdir(), "deplo-auto-"));
  try {
    const auto = build("railpack", true);
    assert.equal(
      (await resolveUploadMethod(dir, auto)).buildMethod,
      "railpack",
    );

    await writeFile(join(dir, "docker-compose.yml"), "services: {}\n");
    const compose = await resolveUploadMethod(dir, auto);
    assert.equal(compose.buildMethod, "compose");
    assert.equal(
      compose.methodAuto,
      false,
      "the resolved method is what gets built",
    );

    await writeFile(join(dir, "Dockerfile"), "FROM scratch\n");
    assert.equal(
      (await resolveUploadMethod(dir, auto)).buildMethod,
      "dockerfile",
    );

    // An explicit pick is never second-guessed by the files.
    assert.equal(
      (await resolveUploadMethod(dir, build("railpack"))).buildMethod,
      "railpack",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("findComposeFile prefers the configured file, else the standard names in order", async () => {
  const dir = await mkdtemp(join(tmpdir(), "deplo-compose-"));
  try {
    assert.equal(await findComposeFile(dir), null);
    await writeFile(join(dir, "docker-compose.yml"), "services: {}\n");
    await writeFile(join(dir, "compose.yaml"), "services: {}\n");
    assert.equal(await findComposeFile(dir), "compose.yaml");
    await mkdir(join(dir, "deploy"));
    await writeFile(join(dir, "deploy", "prod.yml"), "services: {}\n");
    assert.equal(
      await findComposeFile(dir, "deploy/prod.yml"),
      "deploy/prod.yml",
    );
    assert.equal(await findComposeFile(dir, "missing.yml"), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
