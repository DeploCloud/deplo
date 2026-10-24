import { test } from "node:test";
import assert from "node:assert/strict";

import { remapBuildInput } from "./build-input";

test("remapBuildInput re-keys rootDir → rootDirectory", () => {
  const out = remapBuildInput({ rootDir: "apps/web" });
  assert.equal(out.rootDirectory, "apps/web");
  assert.ok(!("rootDir" in out), "the stale rootDir key must not survive");
});

test("remapBuildInput re-keys outputDir → outputDirectory", () => {
  const out = remapBuildInput({ outputDir: "dist" });
  assert.equal(out.outputDirectory, "dist");
  assert.ok(!("outputDir" in out), "the stale outputDir key must not survive");
});

test("remapBuildInput re-keys settings → methodSettings, keeping only live keys", () => {
  const out = remapBuildInput({
    settings: {
      composeFile: "deploy/compose.yaml",
      railpackVersion: "0.35.0",
      nixpacksPublishDirectory: "build",
    },
  });
  assert.deepEqual(out.methodSettings, { composeFile: "deploy/compose.yaml" });
  assert.ok(!("settings" in out), "the stale settings key must not survive");
});

test("remapBuildInput maps a method name onto the live builders", () => {
  assert.deepEqual(remapBuildInput({ buildMethod: "dockerfile" }), {
    buildMethod: "dockerfile",
    methodAuto: false,
  });
  assert.deepEqual(remapBuildInput({ buildMethod: "Compose" }), {
    buildMethod: "compose",
    methodAuto: false,
  });
  for (const retired of ["nixpacks", "static", "heroku", "paketo"])
    assert.deepEqual(remapBuildInput({ buildMethod: retired }), {
      buildMethod: "railpack",
      methodAuto: false,
    });
});

test("remapBuildInput reads auto as Detect automatically, keeping the resolved method", () => {
  assert.deepEqual(remapBuildInput({ buildMethod: "auto" }), {
    methodAuto: true,
  });
});

test("remapBuildInput refuses a method Deplo never had", () => {
  assert.throws(
    () => remapBuildInput({ buildMethod: "buildah" }),
    /Unknown build method "buildah"/,
  );
});

test("remapBuildInput passes matching fields through untouched", () => {
  const out = remapBuildInput({
    buildMethod: "railpack",
    installCommand: "npm i",
    buildCommand: "npm run build",
    startCommand: "npm start",
    runtimeVersion: "20",
    port: 3000,
  });
  assert.deepEqual(out, {
    buildMethod: "railpack",
    methodAuto: false,
    installCommand: "npm i",
    buildCommand: "npm run build",
    startCommand: "npm start",
    runtimeVersion: "20",
    port: 3000,
  });
});

test("remapBuildInput only re-keys fields that are present (partial input)", () => {
  const out = remapBuildInput({ rootDir: "src" });
  assert.deepEqual(Object.keys(out), ["rootDirectory"]);
  assert.ok(!("outputDirectory" in out));
  assert.ok(!("methodSettings" in out));
});

test("remapBuildInput keeps an explicit empty-string edit (clearing a field)", () => {
  const out = remapBuildInput({ rootDir: "", outputDir: "" });
  assert.equal(out.rootDirectory, "");
  assert.equal(out.outputDirectory, "");
});

test("remapBuildInput end-to-end: the merge persists the edited rootDirectory", () => {
  const existing = {
    buildMethod: "railpack",
    methodSettings: {},
    rootDirectory: "./",
    installCommand: null,
    buildCommand: null,
    outputDirectory: null,
    startCommand: null,
    runtimeVersion: "",
    port: 3000,
  };
  const remapped = remapBuildInput({
    buildMethod: "railpack",
    settings: {},
    installCommand: "npm i",
    buildCommand: "npm run build",
    outputDir: "build",
    startCommand: "npm start",
    rootDir: "apps/web",
    runtimeVersion: "20",
    port: 3000,
  });
  const merged = { ...existing, ...remapped };
  assert.equal(merged.rootDirectory, "apps/web");
  assert.equal(merged.outputDirectory, "build");
});

test("remapBuildInput tolerates null/undefined input", () => {
  assert.deepEqual(remapBuildInput(undefined), {});
  assert.deepEqual(remapBuildInput(null), {});
});
