import { test } from "node:test";
import assert from "node:assert/strict";

import { generateDockerfile, dockerfileEnvKeys } from "./dockerfile";
import type { BuildConfig } from "../types";

function build(overrides: Partial<BuildConfig> = {}): BuildConfig {
  return {
    buildMethod: "dockerfile",
    methodSettings: {},
    rootDirectory: "",
    includeFilesOutsideRoot: true,
    skipUnchangedDeployments: false,
    installCommand: "",
    buildCommand: "npm run build",
    outputDirectory: "",
    startCommand: "node server.js",
    runtimeVersion: "",
    port: 3000,
    ...overrides,
  };
}

/**
 * Build-time env parity: the generated Dockerfile must declare each resolved
 * env var as `ARG KEY` + `ENV KEY=$KEY` BEFORE the install/build commands, so
 * build-time-inlined config (NEXT_PUBLIC_* et al.) exists while `npm run
 * build` runs. Only NAMES are rendered — the agent supplies values as build
 * args; a value must never be baked into the Dockerfile text.
 */
test("generateDockerfile declares each env key as ARG+ENV before the build steps", () => {
  const df = generateDockerfile(build(), ["NEXT_PUBLIC_API", "DATABASE_URL"]);
  const argIdx = df.indexOf("ARG DATABASE_URL\nENV DATABASE_URL=$DATABASE_URL");
  assert.notEqual(argIdx, -1, `missing ARG/ENV pair in:\n${df}`);
  assert.match(df, /ARG NEXT_PUBLIC_API\nENV NEXT_PUBLIC_API=\$NEXT_PUBLIC_API/);
  // Declarations come before the first RUN (install), so both install and
  // build commands see the vars.
  assert.ok(argIdx < df.indexOf("RUN "), "ARG/ENV must precede the RUN steps");
});

test("generateDockerfile with no env keys matches the var-free shape", () => {
  const df = generateDockerfile(build());
  assert.ok(!df.includes("ARG "), `unexpected ARG in:\n${df}`);
});

test("a user NODE_ENV lands after the default so it wins", () => {
  const df = generateDockerfile(build(), ["NODE_ENV"]);
  const defaultIdx = df.indexOf("ENV NODE_ENV=production");
  const userIdx = df.indexOf("ENV NODE_ENV=$NODE_ENV");
  assert.ok(defaultIdx !== -1 && userIdx !== -1 && userIdx > defaultIdx);
});

test("dockerfileEnvKeys drops non-identifier names, dedupes and sorts", () => {
  assert.deepEqual(
    dockerfileEnvKeys(["B", "A", "B", "not-a-var", "1BAD", "has space", "_OK"]),
    ["A", "B", "_OK"],
  );
});
