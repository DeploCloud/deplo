import type { DeploySource } from "../../types/app";
import type { BuildConfig, GitRepo } from "../../types/build";
import type {
  HealthCheck,
  PublishedPort,
  ResourceLimits,
  VolumeMount,
} from "../../types/container";
import type { DatabaseMount, DatabaseType } from "../../types/database";
import type { EnvTarget } from "../../types/env";
import type { HostMount, NamedVolume } from "../model";

// What one Deplo hands another for a migration (ADR-0034). Both sides run this file, so a change bumps the version.
export const DEPLO_EXPORT_VERSION = 1;

export interface DeploExportVar {
  key: string;
  value: string;
  secret: boolean;
  targets: EnvTarget[];
}

export interface DeploExportSharedVar extends DeploExportVar {
  teamWide: boolean;
  autoInject: boolean;
  projectIds: string[];
  environmentIds: string[];
  appIds: string[];
}

export interface DeploExportDomain {
  host: string;
  port: number | null;
  pathPrefix: string;
  stripPrefix: boolean;
  service: string | null;
  https: boolean;
  certProvider: string | null;
  primary: boolean;
  redirectTo: string | null;
  generated: boolean;
}

export interface DeploExportCron {
  name: string;
  schedule: string;
  command: string;
  service: string | null;
  enabled: boolean;
}

export interface DeploExportBackup {
  schedule: string;
  enabled: boolean;
  retentionCount: number;
  destination: string | null;
}

export interface DeploExportData {
  volumes: NamedVolume[];
  hostMounts: HostMount[];
}

export interface DeploExportApp {
  id: string;
  name: string;
  slug: string;
  projectId: string | null;
  environmentId: string | null;
  folderId: string | null;
  serverId: string;
  status: string;
  source: DeploySource;
  repo: GitRepo | null;
  dockerImage: string | null;
  compose: string | null;
  files: { filePath: string; content: string }[];
  volumes: VolumeMount[];
  ports: PublishedPort[];
  build: BuildConfig;
  autoDeploy: boolean;
  previewEnabled: boolean;
  resources: ResourceLimits | null;
  healthCheck: HealthCheck | null;
  logo: string | null;
  env: DeploExportVar[];
  domains: DeploExportDomain[];
  basicAuth: { username: string; password: string }[];
  crons: DeploExportCron[];
  backups: DeploExportBackup[];
  data: DeploExportData;
  notes: string[];
}

export interface DeploExportDatabase {
  id: string;
  name: string;
  type: DatabaseType;
  version: string;
  host: string;
  username: string;
  dbName: string;
  password: string;
  environmentId: string | null;
  serverId: string;
  status: string;
  exposedPort: number | null;
  customImage: string | null;
  customCommand: string | null;
  resources: ResourceLimits | null;
  mounts: DatabaseMount[];
  crons: DeploExportCron[];
  backups: DeploExportBackup[];
  data: DeploExportData;
  notes: string[];
}

export interface DeploExportDestination {
  name: string;
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export interface DeploExport {
  version: number;
  instance: string;
  team: { id: string; name: string; slug: string };
  otherTeams: string[];
  canControl: { apps: boolean; databases: boolean };
  projects: {
    id: string;
    name: string;
    environments: { id: string; name: string; isDefault: boolean }[];
  }[];
  folders: { id: string; name: string; parentId: string | null }[];
  apps: DeploExportApp[];
  // Apps in folders the caller cannot open: counted, never named.
  withheld: number;
  databases: DeploExportDatabase[];
  sharedVars: DeploExportSharedVar[];
  servers: {
    id: string;
    name: string;
    address: string | null;
    isDeploHost: boolean;
  }[];
  members: { email: string; name: string | null; role: string | null }[];
  destinations: DeploExportDestination[];
}
