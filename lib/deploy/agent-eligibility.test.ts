import { test } from "node:test";
import assert from "node:assert/strict";

import { agentCanHandle, explicitDockerfileDescriptor } from "./agent-deploy";
import type { BuildConfig } from "../types";

/**
 * Part A routes ONLY the Dockerfile-family build (explicit Dockerfile, or the
 * generated/auto Node Dockerfile) and prebuilt images through the agent; the
 * heavy builders stay on the local path. agentCanHandle is the gate, so its
 * decisions are the contract for "what the agent owns in Part A".
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

test("image source (no build config) is agent-eligible", () => {
  assert.equal(agentCanHandle(null), true);
});

test("the dockerfile method is agent-eligible", () => {
  assert.equal(agentCanHandle(build("dockerfile")), true);
});

test("the heavy builders are NOT agent-eligible in Part A", () => {
  for (const m of ["nixpacks", "railpack", "heroku", "paketo", "static"] as const) {
    assert.equal(agentCanHandle(build(m)), false, `${m} should stay local`);
  }
});

test("DEPLO_AGENT_DEPLOY=off disables the agent path entirely", () => {
  const prev = process.env.DEPLO_AGENT_DEPLOY;
  process.env.DEPLO_AGENT_DEPLOY = "off";
  try {
    assert.equal(agentCanHandle(null), false);
    assert.equal(agentCanHandle(build("dockerfile")), false);
  } finally {
    if (prev === undefined) delete process.env.DEPLO_AGENT_DEPLOY;
    else process.env.DEPLO_AGENT_DEPLOY = prev;
  }
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
