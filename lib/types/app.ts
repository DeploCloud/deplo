import type { FrameworkId } from "../apps/framework-catalog";
import type { ID } from "./identity";
import type { BuildConfig, GitRepo } from "./build";
import type {
  HealthCheck,
  PublishedPort,
  ResourceLimits,
  VolumeMount,
} from "./container";

export type AppStatus =
  | "active"
  | "building"
  | "error"
  | "queued"
  | "idle"
  | "stopping"
  | "restoring";

export type DeploySource =
  "github" | "git" | "docker-image" | "upload" | "compose";

export function deploySourceEnumName(source: DeploySource): string {
  return source.replace(/-/g, "_").toUpperCase();
}

export interface UploadArchive {
  id: ID;
  filename: string;
  path: string;
  size: number;
  uploadedAt: string;
}

export interface App {
  id: ID;
  name: string;
  slug: string;
  teamId: ID;
  folderId?: ID | null;
  projectId?: ID | null;
  environmentId?: ID | null;
  serverId: ID;
  migrateFromServerId?: ID | null;
  dataCopyError: string;
  migrationRunId: ID | null;
  buildServerId?: ID | null;
  buildFallback: boolean;
  logo: string | null;
  logoTone: "dark" | "light" | null;
  framework: FrameworkId | null;
  frameworkOverride: FrameworkId | null;
  source: DeploySource;
  repo: GitRepo | null;
  dockerImage: string | null;
  upload: UploadArchive | null;
  compose: string | null;
  mounts?: { filePath: string; content: string }[] | null;
  volumes?: VolumeMount[] | null;
  ports?: PublishedPort[] | null;
  build: BuildConfig;
  productionUrl: string | null;
  status: AppStatus;
  autoDeploy: boolean;
  previewEnabled: boolean;
  cronEnabled: boolean;
  consoleEnabled: boolean;
  restartLoopGuard: boolean;
  restartLoopStoppedAt?: string | null;
  deployHookEnabled: boolean;
  composeUpArgs: string | null;
  rollbackKeep: number;
  resources: ResourceLimits | null;
  healthCheck: HealthCheck | null;
  latestDeploymentId: ID | null;
  deletingAt?: string | null;
  pendingChangesAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export const DEFAULT_ROLLBACK_KEEP = 3;

export const MAX_ROLLBACK_KEEP = 20;
