import "server-only";

import type { BuildConfig, BuildMethodSettings } from "../../types/build";
import type {
  appBuild,
  appBuildMethodSettings,
} from "../../db/schema/control-plane/apps";

export type AppBuildRow = typeof appBuild.$inferSelect;
export type AppBuildMethodSettingsRow =
  typeof appBuildMethodSettings.$inferSelect;

type AppBuildInsert = typeof appBuild.$inferInsert;
type AppBuildMethodSettingsInsert = typeof appBuildMethodSettings.$inferInsert;

export function assembleBuild(
  build: AppBuildRow,
  ms: AppBuildMethodSettingsRow | null,
): BuildConfig {
  const rawMethod = build.buildMethod;
  const buildMethod =
    rawMethod === "heroku" || rawMethod === "paketo" ? "nixpacks" : rawMethod;
  return {
    buildMethod: buildMethod as BuildConfig["buildMethod"],
    methodSettings: assembleMethodSettings(ms),
    rootDirectory: build.rootDirectory,
    includeFilesOutsideRoot: build.includeFilesOutsideRoot,
    skipUnchangedDeployments: build.skipUnchangedDeployments,
    buildCache: build.buildCache,
    buildCacheClearPending: build.buildCacheClearPending,
    installCommand: build.installCommand,
    buildCommand: build.buildCommand,
    outputDirectory: build.outputDirectory,
    startCommand: build.startCommand,
    runtimeVersion: build.runtimeVersion,
    port: build.port,
  };
}

export function assembleMethodSettings(
  ms: AppBuildMethodSettingsRow | null,
): BuildMethodSettings {
  const out: BuildMethodSettings = {};
  if (!ms) return out;
  if (ms.dockerfilePath != null) out.dockerfilePath = ms.dockerfilePath;
  if (ms.dockerContextPath != null)
    out.dockerContextPath = ms.dockerContextPath;
  if (ms.dockerBuildStage != null) out.dockerBuildStage = ms.dockerBuildStage;
  if (ms.railpackVersion != null) out.railpackVersion = ms.railpackVersion;
  if (ms.nixpacksPublishDirectory != null)
    out.nixpacksPublishDirectory = ms.nixpacksPublishDirectory;
  if (ms.staticSinglePageApp != null)
    out.staticSinglePageApp = ms.staticSinglePageApp;
  return out;
}

export function buildToRow(appId: string, b: BuildConfig): AppBuildInsert {
  return {
    appId,
    buildMethod: b.buildMethod,
    rootDirectory: b.rootDirectory,
    includeFilesOutsideRoot: b.includeFilesOutsideRoot,
    skipUnchangedDeployments: b.skipUnchangedDeployments,
    buildCache: b.buildCache,
    buildCacheClearPending: b.buildCacheClearPending,
    installCommand: b.installCommand,
    buildCommand: b.buildCommand,
    outputDirectory: b.outputDirectory,
    startCommand: b.startCommand,
    runtimeVersion: b.runtimeVersion,
    port: b.port,
  };
}

// The agent pastes this into a download URL it runs as root, so a "/" or ".." would fetch somebody else's asset.
export function cleanToolVersion(
  raw: string | null | undefined,
): string | null {
  const v = (raw ?? "").trim();
  if (!v) return null;
  if (v.toLowerCase() === "latest") return "latest";
  const m = /^v?(\d+\.\d+\.\d+)$/.exec(v);
  if (!m) throw new Error("Use a version like 1.2.3, or latest");
  return m[1];
}

export function methodSettingsToRow(
  appId: string,
  ms: BuildMethodSettings,
): AppBuildMethodSettingsInsert {
  const cols = {
    dockerfilePath: ms.dockerfilePath ?? null,
    dockerContextPath: ms.dockerContextPath ?? null,
    dockerBuildStage: ms.dockerBuildStage ?? null,
    railpackVersion: cleanToolVersion(ms.railpackVersion),
    nixpacksPublishDirectory: ms.nixpacksPublishDirectory ?? null,
    staticSinglePageApp: ms.staticSinglePageApp ?? null,
  } satisfies Record<keyof BuildMethodSettings, unknown>;
  return { appId, ...cols };
}
