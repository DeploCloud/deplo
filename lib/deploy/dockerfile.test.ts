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

/**
 * Layer-cache discipline: on the default path the dependency manifests are
 * copied and installed BEFORE the source (`COPY . .`), so a code-only push
 * reuses the cached install layer instead of reinstalling from scratch — the
 * fix for builds that were a cold `npm install` on every deploy.
 */
test("default path installs from manifests BEFORE copying the source", () => {
  const df = generateDockerfile(build({ installCommand: "" }));
  const manifestCopy = df.indexOf("COPY package.json ");
  const installRun = df.indexOf("RUN if [ -f pnpm-lock.yaml ]");
  const sourceCopy = df.indexOf("COPY . .");
  assert.ok(manifestCopy !== -1, `missing manifest COPY in:\n${df}`);
  assert.ok(installRun !== -1, `missing auto-install RUN in:\n${df}`);
  assert.ok(sourceCopy !== -1, `missing source COPY in:\n${df}`);
  // manifests → install → source, in that order.
  assert.ok(manifestCopy < installRun, "manifests must be copied before install");
  assert.ok(installRun < sourceCopy, "install must run before the source is copied");
});

/**
 * Dev-dependency discipline: `ENV NODE_ENV=production` makes npm/pnpm drop
 * devDependencies, which starves the build of its tooling. The generated
 * install forces them back in so `npm run build` & friends can run.
 */
test("default install forces devDependencies in for every manager", () => {
  const df = generateDockerfile(build());
  assert.match(df, /npm ci --include=dev/, "npm-with-lockfile must keep dev deps");
  assert.match(df, /npm install --include=dev/, "npm-no-lockfile must keep dev deps");
  assert.match(df, /pnpm install --frozen-lockfile --prod=false/, "pnpm must keep dev deps");
});

/**
 * pnpm runs ONLY when the repo pins `packageManager`, so Corepack resolves a
 * version compatible with the base Node (an unpinned repo would pull the latest
 * pnpm, which can refuse to run on node:20). Everything else resolves via npm.
 */
test("pnpm is gated behind a pinned packageManager", () => {
  const df = generateDockerfile(build());
  assert.match(
    df,
    /\[ -f pnpm-lock\.yaml \] && grep -q '"packageManager"' package\.json/,
    "pnpm branch must require both the lockfile and a pinned packageManager",
  );
});

/**
 * A user-supplied installCommand keeps the copy-everything-first order (a
 * custom install may read source files) and is emitted verbatim, with none of
 * the auto-detect/dev-dep machinery layered on top.
 */
test("a custom installCommand copies the source first and runs verbatim", () => {
  const df = generateDockerfile(build({ installCommand: "pnpm i --frozen-lockfile" }));
  const sourceCopy = df.indexOf("COPY . .");
  const installRun = df.indexOf("RUN pnpm i --frozen-lockfile");
  assert.ok(sourceCopy !== -1 && installRun !== -1, `unexpected shape:\n${df}`);
  assert.ok(sourceCopy < installRun, "custom install must see the full source");
  assert.ok(!df.includes("--include=dev"), "custom install must not inherit auto-detect flags");
  assert.ok(!df.includes("grep -q"), "custom install must not inherit the manager probe");
});

/**
 * The manifest COPY anchors on the literal package.json (a Node app always has
 * one) and lists every lockfile as a wildcard, so a repo missing a given
 * lockfile is skipped rather than failing the COPY.
 */
test("manifest COPY anchors on package.json with wildcard lockfiles", () => {
  const df = generateDockerfile(build());
  assert.match(
    df,
    /COPY package\.json package-lock\.json\* npm-shrinkwrap\.json\* pnpm-lock\.yaml\* pnpm-workspace\.yaml\* \.npmrc\* \.\//,
  );
});
