import type { GitProviderId } from "./git";

export type GitTriggerType = "push" | "tag";

export interface GitRepo {
  provider: "github" | GitProviderId;
  url: string;
  repo: string;
  branch: string;
  installationId?: string | null;
  connectionId?: string | null;
  triggerType?: GitTriggerType;
  watchPaths?: string[];
  submodules?: boolean;
}

export type BuildMethod = "railpack" | "dockerfile" | "compose";

export interface BuildMethodSettings {
  dockerfilePath?: string;
  dockerContextPath?: string;
  dockerBuildStage?: string;
  composeFile?: string;
  staticSinglePageApp?: boolean;
}

export interface BuildConfig {
  // With methodAuto, buildMethod is what the last deploy resolved: a Dockerfile, then a compose file, then Railpack.
  buildMethod: BuildMethod;
  methodAuto: boolean;
  methodSettings: BuildMethodSettings;
  rootDirectory: string;
  includeFilesOutsideRoot: boolean;
  skipUnchangedDeployments: boolean;
  buildCache: boolean;
  buildCacheClearPending: boolean;
  installCommand: string | null;
  buildCommand: string | null;
  outputDirectory: string | null;
  startCommand: string | null;
  runtimeVersion: string;
  port: number;
}
