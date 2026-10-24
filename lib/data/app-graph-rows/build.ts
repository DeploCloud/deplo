import "server-only";

import { normalizeBuildMethod } from "../../frameworks";
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
  return {
    buildMethod: normalizeBuildMethod(build.buildMethod) ?? "railpack",
    methodAuto: build.buildMethodAuto,
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
  if (ms.composeFile != null) out.composeFile = ms.composeFile;
  if (ms.staticSinglePageApp != null)
    out.staticSinglePageApp = ms.staticSinglePageApp;
  return out;
}

export function buildToRow(appId: string, b: BuildConfig): AppBuildInsert {
  return {
    appId,
    buildMethod: normalizeBuildMethod(b.buildMethod) ?? "railpack",
    buildMethodAuto: b.methodAuto ?? false,
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

// The agent re-checks it against the checkout; refusing an escape here names the field.
export function cleanComposeFile(
  raw: string | null | undefined,
): string | null {
  const v = (raw ?? "").trim().replace(/^\.\/+/, "");
  if (!v) return null;
  const parts = v.split("/");
  if (
    v.length > 200 ||
    v.startsWith("/") ||
    !/^[\w./-]+$/.test(v) ||
    parts.some((p) => p === ".." || p === "")
  ) {
    throw new Error(
      "The compose file must be a path inside the repository, like docker-compose.yml or deploy/compose.yaml",
    );
  }
  return v;
}

export function methodSettingsToRow(
  appId: string,
  ms: BuildMethodSettings,
): AppBuildMethodSettingsInsert {
  const cols = {
    dockerfilePath: ms.dockerfilePath ?? null,
    dockerContextPath: ms.dockerContextPath ?? null,
    dockerBuildStage: ms.dockerBuildStage ?? null,
    composeFile: cleanComposeFile(ms.composeFile),
    staticSinglePageApp: ms.staticSinglePageApp ?? null,
  } satisfies Record<keyof BuildMethodSettings, unknown>;
  return { appId, ...cols };
}
