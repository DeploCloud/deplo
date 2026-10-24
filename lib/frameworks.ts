import type { BuildConfig, BuildMethod } from "./types/build";

export const BUILD_METHOD_IDS: readonly BuildMethod[] = [
  "railpack",
  "dockerfile",
  "compose",
];

// The builders Railpack replaced; an old row or an API client may still name one.
const RETIRED_METHODS = new Set(["nixpacks", "static", "heroku", "paketo"]);

// Maps a stored or submitted method name onto a live one; null for a name Deplo never had.
export function normalizeBuildMethod(
  raw: string | null | undefined,
): BuildMethod | null {
  const m = (raw ?? "").trim().toLowerCase();
  if (!m) return null;
  if ((BUILD_METHOD_IDS as readonly string[]).includes(m))
    return m as BuildMethod;
  if (RETIRED_METHODS.has(m)) return "railpack";
  return null;
}

export function buildConfigFor(
  overrides: Partial<BuildConfig> = {},
): BuildConfig {
  return {
    buildMethod: overrides.buildMethod ?? "railpack",
    methodAuto: false,
    methodSettings: {
      dockerfilePath: "Dockerfile",
      dockerContextPath: ".",
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

  const method = normalizeBuildMethod(normalized.buildMethod) ?? "railpack";
  if (method !== normalized.buildMethod) {
    normalized = { ...normalized, buildMethod: method };
  }

  if (
    normalized.includeFilesOutsideRoot == null ||
    normalized.skipUnchangedDeployments == null ||
    normalized.buildCache == null ||
    normalized.buildCacheClearPending == null ||
    normalized.methodAuto == null
  ) {
    normalized = {
      ...normalized,
      includeFilesOutsideRoot: normalized.includeFilesOutsideRoot ?? true,
      skipUnchangedDeployments: normalized.skipUnchangedDeployments ?? false,
      buildCache: normalized.buildCache ?? true,
      buildCacheClearPending: normalized.buildCacheClearPending ?? false,
      methodAuto: normalized.methodAuto ?? false,
    };
  }

  if (normalized.methodSettings) return normalized;
  // A row from before the settings table existed: seed the method's defaults.
  return buildConfigFor({ ...normalized, methodSettings: {} });
}
