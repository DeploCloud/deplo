import type { BuildConfig } from "./types/build";

// DEFAULT_NODE_MAJOR - the Node major the auto-detecting builders pin when the user pinned nothing.
export const DEFAULT_NODE_MAJOR = "24";

// usesDefaultNodeMajor - true for the auto-detecting Node builders; the Dockerfile and static builders handle versions themselves.
export function usesDefaultNodeMajor(
  method: BuildConfig["buildMethod"],
): boolean {
  return method === "nixpacks" || method === "railpack";
}

// buildConfigFor - a full BuildConfig from overrides; the default builder is Railpack (Nixpacks serves a built static site only for Vite).
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
    // NULL, not "": an empty string would mean "run nothing" and every new app would skip its own install.
    installCommand: null,
    buildCommand: null,
    outputDirectory: null,
    startCommand: null,
    runtimeVersion: "",
    port: 3000,
    ...overrides,
  };
}

// normalizeBuildConfig - backfill build-method fields on a config stored before they existed.
export function normalizeBuildConfig(build: BuildConfig): BuildConfig {
  const legacyVersion = (build as { nodeVersion?: string }).nodeVersion;
  let normalized: BuildConfig =
    build.runtimeVersion == null && legacyVersion != null
      ? { ...build, runtimeVersion: legacyVersion }
      : build;

  // The removed Heroku/Paketo methods remap to Nixpacks, the closest surviving auto-detecting builder.
  const legacyMethod = normalized.buildMethod as string;
  if (legacyMethod === "heroku" || legacyMethod === "paketo") {
    normalized = { ...normalized, buildMethod: "nixpacks" };
  }

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
      // Caching is the default: a config read before the column existed has been building WITH the cache all along.
      buildCache: normalized.buildCache ?? true,
      buildCacheClearPending: normalized.buildCacheClearPending ?? false,
    };
  }

  if (normalized.buildMethod && normalized.methodSettings) return normalized;
  // A config written before build methods existed built on Nixpacks - the Railpack default is for a NEW app only.
  const seeded = buildConfigFor({
    ...normalized,
    buildMethod: normalized.buildMethod ?? "nixpacks",
  });
  return {
    ...seeded,
    methodSettings: { ...seeded.methodSettings, ...normalized.methodSettings },
  };
}
