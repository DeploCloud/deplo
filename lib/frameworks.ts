import type { BuildConfig } from "./types/build";

export const DEFAULT_NODE_MAJOR = "24";

export function usesDefaultNodeMajor(
  method: BuildConfig["buildMethod"],
): boolean {
  return method === "nixpacks" || method === "railpack";
}

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
    installCommand: null,
    buildCommand: null,
    outputDirectory: null,
    startCommand: null,
    runtimeVersion: "",
    port: 3000,
    ...overrides,
  };
}

export function normalizeBuildConfig(build: BuildConfig): BuildConfig {
  const legacyVersion = (build as { nodeVersion?: string }).nodeVersion;
  let normalized: BuildConfig =
    build.runtimeVersion == null && legacyVersion != null
      ? { ...build, runtimeVersion: legacyVersion }
      : build;

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
      buildCache: normalized.buildCache ?? true,
      buildCacheClearPending: normalized.buildCacheClearPending ?? false,
    };
  }

  if (normalized.buildMethod && normalized.methodSettings) return normalized;
  const seeded = buildConfigFor({
    ...normalized,
    buildMethod: normalized.buildMethod ?? "nixpacks",
  });
  return {
    ...seeded,
    methodSettings: { ...seeded.methodSettings, ...normalized.methodSettings },
  };
}
