import { test } from "node:test";
import assert from "node:assert/strict";

import {
  agentCanHandle,
  agentCapabilityForMethod,
  buildSpecFor,
  explicitDockerfileDescriptor,
} from "./agent-deploy";
import type { BuildConfig } from "../types";

/**
 * The agent now runs EVERY build method (the Dockerfile family + the heavy
 * builders static/nixpacks/buildpacks/railpack, ported to deplo-agent). So
 * agentCanHandle is always true; the real gate is per-server —
 * agentCapabilityForMethod names the Hello capability the owning agent must
 * advertise, and the deploy path checks it before routing.
 */

function build(method: BuildConfig["buildMethod"]): BuildConfig {
  return {
    framework: "node",
    buildMethod: method,
    methodSettings: {},
    rootDirectory: "",
    installCommand: "",
    buildCommand: "",
    outputDirectory: "",
    startCommand: "",
    runtimeVersion: "",
    port: 3000,
  };
}

test("image source (no build config) is agent-eligible and needs no heavy capability", () => {
  assert.equal(agentCanHandle(null), true);
  assert.equal(agentCapabilityForMethod(null), null);
});

test("every build method is now agent-eligible", () => {
  for (const m of ["dockerfile", "nixpacks", "railpack", "heroku", "paketo", "static"] as const) {
    assert.equal(agentCanHandle(build(m)), true, `${m} is agent-eligible`);
  }
});

test("the dockerfile family needs no heavy capability; each heavy method names its own", () => {
  assert.equal(agentCapabilityForMethod(build("dockerfile")), null);
  assert.equal(agentCapabilityForMethod(build("static")), "deploy.static");
  assert.equal(agentCapabilityForMethod(build("nixpacks")), "deploy.nixpacks");
  // heroku + paketo are both Cloud Native Buildpacks → one capability.
  assert.equal(agentCapabilityForMethod(build("heroku")), "deploy.buildpacks");
  assert.equal(agentCapabilityForMethod(build("paketo")), "deploy.buildpacks");
  assert.equal(agentCapabilityForMethod(build("railpack")), "deploy.railpack");
});

test("buildSpecFor flattens the build config + resolves the runtime language", () => {
  const b = build("nixpacks");
  b.installCommand = "npm ci";
  b.buildCommand = "npm run build";
  b.startCommand = "node server.js";
  b.runtimeVersion = "20";
  b.methodSettings = { nixpacksPublishDirectory: "dist", staticSinglePageApp: true };
  const spec = buildSpecFor(b);
  assert.equal(spec.method, "nixpacks");
  assert.equal(spec.port, 3000);
  assert.equal(spec.installCommand, "npm ci");
  assert.equal(spec.buildCommand, "npm run build");
  assert.equal(spec.startCommand, "node server.js");
  assert.equal(spec.runtimeVersion, "20");
  assert.equal(spec.runtimeLanguage, "node", "node framework → node language");
  assert.equal(spec.nixpacksPublishDirectory, "dist");
  assert.equal(spec.staticSinglePageApp, true);
});

test("explicit dockerfile descriptor carries methodSettings (parity with builders.ts)", () => {
  // The bug this guards: dropping these silently shipped the wrong image (the
  // last stage of a multi-stage Dockerfile instead of the chosen --target).
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

test("explicit dockerfile descriptor defaults match builders.ts when unset", () => {
  const d = explicitDockerfileDescriptor(build("dockerfile"));
  assert.equal(d.dockerfilePath, "Dockerfile");
  assert.equal(d.contextPath, ".");
  assert.equal(d.targetStage, "");
  assert.equal(d.generated, false);
});
