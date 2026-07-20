/**
 * Build-config seeding. Pure and isomorphic: used both in the
 * new-project wizard (client) and on the server when a deployment is created.
 *
 * Framework presets were removed (ADR: the build methods auto-detect the stack),
 * so this module no longer detects frameworks — it just seeds a default
 * BuildConfig.
 */
import type { BuildConfig } from "./types";

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
 * Backfill build-method fields on a BuildConfig read from the store. Apps
 * created before build methods existed have no `buildMethod`/`methodSettings`;
 * seed sane defaults so old apps keep deploying and the settings form
 * renders. Pure and idempotent — safe to call on every read.
 */
export function normalizeBuildConfig(build: BuildConfig): BuildConfig {
  // Migrate the legacy `nodeVersion` field to the language-neutral
  // `runtimeVersion` (older apps stored only `nodeVersion`).
  const legacyVersion = (build as { nodeVersion?: string }).nodeVersion;
  let normalized: BuildConfig =
    build.runtimeVersion == null && legacyVersion != null
      ? { ...build, runtimeVersion: legacyVersion }
      : build;

  // The Heroku/Paketo buildpack methods were removed; remap legacy rows to
  // Nixpacks (the surviving auto-detecting builder — the closest equivalent) so
  // those apps keep deploying and the settings UI shows a selected method.
  const legacyMethod = normalized.buildMethod as string;
  if (legacyMethod === "heroku" || legacyMethod === "paketo") {
    normalized = { ...normalized, buildMethod: "nixpacks" };
  }

  // The root-directory build toggles were added later; a config read before they
  // existed (or a partial fixture) may lack them. Seed the shipping defaults so
  // every normalized config carries them (whole repo in context; don't skip).
  if (
    normalized.includeFilesOutsideRoot == null ||
    normalized.skipUnchangedDeployments == null
  ) {
    normalized = {
      ...normalized,
      includeFilesOutsideRoot: normalized.includeFilesOutsideRoot ?? true,
      skipUnchangedDeployments: normalized.skipUnchangedDeployments ?? false,
    };
  }

  if (normalized.buildMethod && normalized.methodSettings) return normalized;
  const seeded = buildConfigFor(normalized);
  return {
    ...seeded,
    methodSettings: { ...seeded.methodSettings, ...normalized.methodSettings },
  };
}
