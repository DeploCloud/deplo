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

/** Reassemble a {@link BuildConfig} from the `app_build` (+ method-settings) rows. */
export function assembleBuild(
  build: AppBuildRow,
  ms: AppBuildMethodSettingsRow | null,
): BuildConfig {
  // Legacy rows may still hold the removed "heroku"/"paketo" build methods.
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

/** Reassemble {@link BuildMethodSettings} from its 1-to-1 row. */
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

/**
 * A build tool's pinned version: `1.2.3`, with or without a `v`, `latest`, or
 * nothing. The agent pastes it into a download URL it then executes as root, so
 * a `/` or `..` in it would be a path to somebody else's release asset.
 */
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

/** The 1-to-1 `app_build_method_settings` row. */
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
