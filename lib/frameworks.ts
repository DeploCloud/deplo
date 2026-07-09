/**
 * Build-config seeding + dev-image presets. Pure and isomorphic: used both in the
 * new-project wizard (client) and on the server when a deployment is created.
 *
 * Framework presets were removed (ADR: the build methods auto-detect the stack),
 * so this module no longer detects frameworks — it just seeds a default
 * BuildConfig and resolves the dev container's base image.
 */
import type { BuildConfig, DevImagePreset } from "./types";

/**
 * Official base image each dev image preset resolves to (ADR-0004). Used
 * directly — Deplo builds no per-language dev images. `node` is the safe
 * fallback (the JS toolchain covers most source-bearing services).
 */
export const DEV_PRESET_IMAGE: Record<DevImagePreset, string> = {
  node: "node:22",
  python: "python:3.12",
  go: "golang:1.23",
  rust: "rust:1",
  php: "php:8.3",
  java: "eclipse-temurin:21",
};

/** Resolve a dev image preset id to the official base image it runs on. */
export function devPresetImage(preset: DevImagePreset): string {
  return DEV_PRESET_IMAGE[preset] ?? DEV_PRESET_IMAGE.node;
}

/**
 * Default Node.js MAJOR the auto-detecting Node builders (Nixpacks / Railpack)
 * pin when the user pinned nothing. Without a pin these builders fall back to
 * their own built-in default — historically an old line (Nixpacks selected
 * Node 18) — so Deplo forces a current major instead. A bare major, as the
 * builders expect (`NIXPACKS_NODE_VERSION` / `RAILPACK_NODE_VERSION`). Isomorphic
 * so the build settings UI can show the same default it will actually build with.
 */
export const DEFAULT_NODE_MAJOR = "24";

/** Whether a build method runs an auto-detecting Node builder that honours
 * {@link DEFAULT_NODE_MAJOR} (Nixpacks / Railpack). The Dockerfile family and the
 * static builder keep their own version handling. */
export function usesDefaultNodeMajor(method: BuildConfig["buildMethod"]): boolean {
  return method === "nixpacks" || method === "railpack";
}

/**
 * Build a full {@link BuildConfig} from optional overrides. Defaults to the
 * zero-config Nixpacks builder with empty commands (the builders auto-detect the
 * language and build steps); the caller overrides `buildMethod`, `methodSettings`
 * and `port` from the UI.
 */
export function buildConfigFor(overrides: Partial<BuildConfig> = {}): BuildConfig {
  return {
    buildMethod: overrides.buildMethod ?? "nixpacks",
    methodSettings: {
      dockerfilePath: "Dockerfile",
      dockerContextPath: ".",
      railpackVersion: "latest",
      staticSinglePageApp: false,
      ...overrides.methodSettings,
    },
    rootDirectory: "./",
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
 * Backfill build-method fields on a BuildConfig read from the store. Services
 * created before build methods existed have no `buildMethod`/`methodSettings`;
 * seed sane defaults so old services keep deploying and the settings form
 * renders. Pure and idempotent — safe to call on every read.
 */
export function normalizeBuildConfig(build: BuildConfig): BuildConfig {
  // Migrate the legacy `nodeVersion` field to the language-neutral
  // `runtimeVersion` (older services stored only `nodeVersion`).
  const legacyVersion = (build as { nodeVersion?: string }).nodeVersion;
  let normalized: BuildConfig =
    build.runtimeVersion == null && legacyVersion != null
      ? { ...build, runtimeVersion: legacyVersion }
      : build;

  // The Heroku/Paketo buildpack methods were removed; remap legacy rows to
  // Nixpacks (the surviving auto-detecting builder — the closest equivalent) so
  // those services keep deploying and the settings UI shows a selected method.
  const legacyMethod = normalized.buildMethod as string;
  if (legacyMethod === "heroku" || legacyMethod === "paketo") {
    normalized = { ...normalized, buildMethod: "nixpacks" };
  }

  if (normalized.buildMethod && normalized.methodSettings) return normalized;
  const seeded = buildConfigFor(normalized);
  return {
    ...seeded,
    methodSettings: { ...seeded.methodSettings, ...normalized.methodSettings },
  };
}
