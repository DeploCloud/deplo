/**
 * Build-config seeding.
 */
import type { BuildConfig } from "./types";

/**
 * Default Node.js MAJOR the auto-detecting Node builders (Nixpacks / Railpack) pin
 * when the user pinned nothing.
 */
export const DEFAULT_NODE_MAJOR = "24";

/** Whether a build method runs an auto-detecting Node builder that honours
 * {@link DEFAULT_NODE_MAJOR} (Nixpacks / Railpack). The Dockerfile family and the
 * static builder keep their own version handling. */
export function usesDefaultNodeMajor(
  method: BuildConfig["buildMethod"],
): boolean {
  return method === "nixpacks" || method === "railpack";
}

/**
 * Build a full {@link BuildConfig} from optional overrides. The default builder is
 * Railpack: Nixpacks serves a built static site only for Vite, so Angular, Astro,
 * CRA and React Router SPAs had no production serve at all under it.
 */
export function buildConfigFor(
  overrides: Partial<BuildConfig> = {},
): BuildConfig {
  return {
    buildMethod: overrides.buildMethod ?? "railpack",
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
    buildCache: true,
    buildCacheClearPending: false,
    // NULL, not "": a new app lets the builder work these out. An empty string
    // would mean "run nothing", and every new app would skip its own install.
    installCommand: null,
    buildCommand: null,
    outputDirectory: null,
    startCommand: null,
    runtimeVersion: "",
    port: 3000,
    ...overrides,
  };
}

/**
 * Backfill build-method fields on a BuildConfig read from the store. Apps created
 * before build methods existed have no `buildMethod`/`methodSettings`; seed sane
 * defaults so old apps keep deploying and the settings form renders.
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
  // Nixpacks (the surviving auto-detecting builder - the closest equivalent) so
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
    normalized.skipUnchangedDeployments == null ||
    normalized.buildCache == null ||
    normalized.buildCacheClearPending == null
  ) {
    normalized = {
      ...normalized,
      includeFilesOutsideRoot: normalized.includeFilesOutsideRoot ?? true,
      skipUnchangedDeployments: normalized.skipUnchangedDeployments ?? false,
      // Caching is the default: a config read before the column existed is an
      // app that has been building WITH the cache all along.
      buildCache: normalized.buildCache ?? true,
      buildCacheClearPending: normalized.buildCacheClearPending ?? false,
    };
  }

  if (normalized.buildMethod && normalized.methodSettings) return normalized;
  // A config written before build methods existed built on Nixpacks, so that is what
  // it keeps - the Railpack default is for a NEW app, never a silent switch.
  const seeded = buildConfigFor({
    ...normalized,
    buildMethod: normalized.buildMethod ?? "nixpacks",
  });
  return {
    ...seeded,
    methodSettings: { ...seeded.methodSettings, ...normalized.methodSettings },
  };
}
