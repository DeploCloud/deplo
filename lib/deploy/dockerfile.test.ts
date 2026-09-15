import { test } from "node:test";
import assert from "node:assert/strict";

import { generateDockerfile, dockerfileEnvKeys } from "./dockerfile";
import type { BuildConfig } from "../types/build";

function build(overrides: Partial<BuildConfig> = {}): BuildConfig {
  return {
    buildMethod: "dockerfile",
    methodSettings: {},
    rootDirectory: "",
    includeFilesOutsideRoot: true,
    skipUnchangedDeployments: false,
    buildCache: true,
    buildCacheClearPending: false,
    installCommand: null,
    buildCommand: "npm run build",
    outputDirectory: null,
    startCommand: "node server.js",
    runtimeVersion: "",
    port: 3000,
    ...overrides,
  };
}

test("generateDockerfile declares each env key as ARG before the build steps", () => {
  const df = generateDockerfile(build(), ["NEXT_PUBLIC_API", "DATABASE_URL"]);
  const argIdx = df.indexOf("ARG DATABASE_URL\n");
  assert.notEqual(argIdx, -1, `missing ARG in:\n${df}`);
  assert.match(df, /ARG NEXT_PUBLIC_API\n/);
  assert.ok(argIdx < df.indexOf("RUN "), "the ARGs must precede the RUN steps");
});

test("generateDockerfile never declares a build var as ENV", () => {
  const df = generateDockerfile(build(), [
    "PAYLOAD_SECRET",
    "S3_ACCESS_KEY_ID",
  ]);
  assert.ok(!df.includes("ENV PAYLOAD_SECRET"), df);
  assert.ok(!df.includes("ENV S3_ACCESS_KEY_ID"), df);
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

test("default path installs from manifests BEFORE copying the source", () => {
  const df = generateDockerfile(build({ installCommand: null }));
  const manifestCopy = df.indexOf("COPY package.json ");
  const installRun = df.indexOf("RUN if [ -f pnpm-lock.yaml ]");
  const sourceCopy = df.indexOf("COPY . .");
  assert.ok(manifestCopy !== -1, `missing manifest COPY in:\n${df}`);
  assert.ok(installRun !== -1, `missing auto-install RUN in:\n${df}`);
  assert.ok(sourceCopy !== -1, `missing source COPY in:\n${df}`);
  assert.ok(
    manifestCopy < installRun,
    "manifests must be copied before install",
  );
  assert.ok(
    installRun < sourceCopy,
    "install must run before the source is copied",
  );
});

test("default install forces devDependencies in for every manager", () => {
  const df = generateDockerfile(build());
  assert.match(
    df,
    /npm ci --include=dev/,
    "npm-with-lockfile must keep dev deps",
  );
  assert.match(
    df,
    /npm install --include=dev/,
    "npm-no-lockfile must keep dev deps",
  );
  assert.match(
    df,
    /pnpm install --frozen-lockfile --prod=false/,
    "pnpm must keep dev deps",
  );
});

test("pnpm is gated behind a pinned packageManager", () => {
  const df = generateDockerfile(build());
  assert.match(
    df,
    /\[ -f pnpm-lock\.yaml \] && grep -q '"packageManager"' package\.json/,
    "pnpm branch must require both the lockfile and a pinned packageManager",
  );
});

test("a custom installCommand copies the source first and runs verbatim", () => {
  const df = generateDockerfile(
    build({ installCommand: "pnpm i --frozen-lockfile" }),
  );
  const sourceCopy = df.indexOf("COPY . .");
  const installRun = df.indexOf("RUN pnpm i --frozen-lockfile");
  assert.ok(sourceCopy !== -1 && installRun !== -1, `unexpected shape:\n${df}`);
  assert.ok(sourceCopy < installRun, "custom install must see the full source");
  assert.ok(
    !df.includes("--include=dev"),
    "custom install must not inherit auto-detect flags",
  );
  assert.ok(
    !df.includes("grep -q"),
    "custom install must not inherit the manager probe",
  );
});

test("manifest COPY anchors on package.json with wildcard lockfiles", () => {
  const df = generateDockerfile(build());
  assert.match(
    df,
    /COPY package\.json package-lock\.json\* npm-shrinkwrap\.json\* pnpm-lock\.yaml\* pnpm-workspace\.yaml\* \.npmrc\* \.\//,
  );
});

test("a null build command leaves the builder to work it out", () => {
  const df = generateDockerfile(build({ buildCommand: null }), []);
  assert.match(df, /npm ci --include=dev/);
  assert.doesNotMatch(df, /^RUN npm run build$/m);
});

test("an empty build command runs no build step at all", () => {
  const df = generateDockerfile(build({ buildCommand: "" }), []);
  assert.doesNotMatch(df, /RUN npm run build/);
  assert.match(df, /npm ci --include=dev/);
});

test("an empty install command installs nothing, and still builds", () => {
  const df = generateDockerfile(
    build({ installCommand: "", buildCommand: "npm run build" }),
    [],
  );
  assert.doesNotMatch(df, /npm ci --include=dev/);
  assert.doesNotMatch(df, /COPY package.json/);
  assert.match(df, /RUN npm run build/);
});

test("both empty leaves the repo exactly as it arrived", () => {
  const df = generateDockerfile(
    build({ installCommand: "", buildCommand: "" }),
    [],
  );
  assert.doesNotMatch(df, /npm ci --include=dev/);
  assert.doesNotMatch(df, /RUN npm run build/);
  assert.match(df, /COPY \. \./);
  assert.match(df, /CMD .*node server\.js/);
});

test("an empty start command is not a skip - a container must start something", () => {
  const df = generateDockerfile(build({ startCommand: "" }), []);
  assert.match(df, /CMD .*node server\.js/);
});
