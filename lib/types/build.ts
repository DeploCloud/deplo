import type { DeplopackOverride } from "../apps/deplopack-types";
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

export type BuildMethod =
  "dockerfile" | "railpack" | "nixpacks" | "static" | "deplopack";

export interface BuildMethodSettings {
  deplopackVersion?: string;
  deplopackProvider?: string;
  deplopackPath?: string | null;
  dockerfilePath?: string;
  dockerContextPath?: string;
  dockerBuildStage?: string;
  railpackVersion?: string;
  nixpacksPublishDirectory?: string;
  staticSinglePageApp?: boolean;
}

export interface BuildConfig {
  deplopackInputs?: DeplopackOverride[];
  buildMethod: BuildMethod;
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
