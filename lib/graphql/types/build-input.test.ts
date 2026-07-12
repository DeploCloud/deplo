import { test } from "node:test";
import assert from "node:assert/strict";

import { remapBuildInput } from "./build-input";

/**
 * Regression coverage for the "build settings don't save" bug: the GraphQL
 * `BuildConfigInput` names three fields differently from the stored BuildConfig
 * (`settings`/`rootDir`/`outputDir`), and the shallow merge in updateAppBuild
 * keys off the BuildConfig names. If the remap misses any of them, that edit is
 * silently dropped and reverts to the stored value on reload — which is exactly
 * how Root Directory / Output Directory regressed.
 */

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

test("remapBuildInput re-keys settings → methodSettings", () => {
  const out = remapBuildInput({ settings: { publishDir: "build" } });
  assert.deepEqual(out.methodSettings, { publishDir: "build" });
  assert.ok(!("settings" in out), "the stale settings key must not survive");
});

test("remapBuildInput passes matching fields through untouched", () => {
  const out = remapBuildInput({
    buildMethod: "nixpacks",
    installCommand: "npm i",
    buildCommand: "npm run build",
    startCommand: "npm start",
    runtimeVersion: "20",
    port: 3000,
  });
  assert.deepEqual(out, {
    buildMethod: "nixpacks",
    installCommand: "npm i",
    buildCommand: "npm run build",
    startCommand: "npm start",
    runtimeVersion: "20",
    port: 3000,
  });
});

test("remapBuildInput only re-keys fields that are present (partial input)", () => {
  // The Edit dialog can send just one field; an absent key must NOT appear in the
  // output, so the downstream merge preserves the stored value for it.
  const out = remapBuildInput({ rootDir: "src" });
  assert.deepEqual(Object.keys(out), ["rootDirectory"]);
  assert.ok(!("outputDirectory" in out));
  assert.ok(!("methodSettings" in out));
});

test("remapBuildInput keeps an explicit empty-string edit (clearing a field)", () => {
  // Clearing Root Directory back to "" is a real edit, not a no-op — it must
  // reach the store, not be treated as absent.
  const out = remapBuildInput({ rootDir: "", outputDir: "" });
  assert.equal(out.rootDirectory, "");
  assert.equal(out.outputDirectory, "");
});

test("remapBuildInput end-to-end: the merge persists the edited rootDirectory", () => {
  // Mirrors the shallow merge in updateAppBuild: { ...existing, ...remapped }.
  const existing = {
    buildMethod: "nixpacks",
    methodSettings: {},
    rootDirectory: "./",
    installCommand: "",
    buildCommand: "",
    outputDirectory: "",
    startCommand: "",
    runtimeVersion: "",
    port: 3000,
  };
  const remapped = remapBuildInput({
    buildMethod: "nixpacks",
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
