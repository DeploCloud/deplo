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
  // Absent from a source older than #95, like every field below.
  entrypoint?: string | null;
  middlewares?: string[];
  corsOrigins?: string[];
  securityHeaders?: boolean;
  proxied?: boolean;
  // Only on a custom-certificate domain: the pair, or why it was kept back.
  certificate?: DeploExportCertificate;
}

export type DeploExportCertificate =
  | { certPem: string; keyPem: string }
  | { withheld: "admin" | "missing" | "unreadable" };

export interface DeploExportCron {
  name: string;
  schedule: string;
  command: string;
  service: string | null;
  enabled: boolean;
  // The rest of the job, absent from an older Deplo.
  description?: string;
  timezone?: string;
  shell?: string;
  timeoutSeconds?: number;
  maxAttempts?: number;
  overlap?: string;
  keepRuns?: number;
  workdir?: string | null;
  user?: string | null;
  env?: { key: string; value: string }[];
}

export interface DeploExportBackup {
  schedule: string;
  enabled: boolean;
  retentionCount: number;
  destination: string | null;
  // Absent from a source older than #102, like every field below marked so.
  timezone?: string;
}

// A successful run: a restore point the artifact at `objectKey` still answers for.
export interface DeploExportBackupRun {
  destination: string;
  objectKey: string;
  sizeBytes: number;
  decryptedSizeBytes: number | null;
  sha256: string | null;
  startedAt: string;
  finishedAt: string | null;
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
  // Whether its cron jobs run at all; absent from an older Deplo.
  cronEnabled?: boolean;
  backups: DeploExportBackup[];
  backupRuns?: DeploExportBackupRun[];
  data: DeploExportData;
  notes: string[];
  // The archive an upload app builds from; null when it has none, absent from an older Deplo.
  upload?: DeploExportUpload | null;
  // Preview settings as stored (null = the default) and its preview overrides; absent from an older Deplo.
  preview?: DeploExportPreview;
  previewEnv?: Omit<DeploExportVar, "targets">[];
}

export interface DeploExportPreview {
  baseDomain: string | null;
  maxActive: number | null;
  ttlDays: number | null;
  forkPolicy: string | null;
  serverId: string | null;
  https: boolean;
  autoDeploy: boolean;
  port: number | null;
  buildDrafts: boolean;
  comment: boolean;
  requiredLabels: string | null;
}

export interface DeploExportUpload {
  filename: string;
  size: number;
  uploadedAt: string;
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
  cronEnabled?: boolean;
  backups: DeploExportBackup[];
  backupRuns?: DeploExportBackupRun[];
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
  provider?: string;
  // null: that destination never encrypted. Old artifacts open only with this key.
  ageIdentity?: string | null;
}

export interface DeploExportServerDestination {
  name: string;
  serverId: string;
  serverName: string | null;
  path: string | null;
  ageIdentity?: string;
}

// Colour, kind and branch are absent from an older Deplo; projects come in the team's order.
export interface DeploExportProject {
  id: string;
  name: string;
  color?: string | null;
  environments: DeploExportEnvironment[];
}

export interface DeploExportEnvironment {
  id: string;
  name: string;
  isDefault: boolean;
  kind?: string;
  gitBranch?: string;
}

export interface DeploExport {
  version: number;
  instance: string;
  team: { id: string; name: string; slug: string };
  otherTeams: string[];
  canControl: { apps: boolean; databases: boolean };
  projects: DeploExportProject[];
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
  // Apart from `destinations`, so an older target never reads a disk as a bucket.
  serverDestinations?: DeploExportServerDestination[];
}
