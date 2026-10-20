import type { BuildConfig } from "../types/build";
import type { HealthCheck, ResourceLimits } from "../types/container";
import type { EnvironmentKind } from "../types/team";
import type { EnvPair, SharedRef } from "./map/env";
import type { Note } from "./note";

export type SourceBuildType =
  | "dockerfile"
  | "heroku_buildpacks"
  | "paketo_buildpacks"
  | "nixpacks"
  | "static"
  | "railpack";

export type SourceOrigin =
  "docker" | "git" | "github" | "gitlab" | "bitbucket" | "gitea" | "drop";

export interface SourceDomain {
  domainId: string;
  host: string;
  https?: boolean | null;
  port?: number | null;
  path?: string | null;
  stripPath?: boolean | null;
  internalPath?: string | null;
  serviceName?: string | null;
  customEntrypoint?: string | null;
  domainType?: "application" | "compose" | "preview" | null;
  certificateType?: "letsencrypt" | "none" | "custom" | null;
  enabled?: boolean | null;
  // A host the source platform minted for itself, which never comes across as a domain someone owns.
  generated?: boolean | null;
  primary?: boolean | null;
  // A domain's own rules, already in Deplo's shape; only another Deplo sends them.
  nativeRules?: SourceDomainRules | null;
}

export interface SourceDomainRules {
  entrypoint?: "web" | "websecure" | null;
  middlewares?: string[];
  corsOrigins?: string[];
  securityHeaders?: boolean;
  proxied?: boolean;
  // Set on a domain that only redirects there; it comes across once that host has.
  redirectTo?: string | null;
  // Only on a custom-certificate domain: the pair, or why it did not come across.
  certificate?: SourceCertificate;
}

export type SourceCertificate =
  | { certPem: string; keyPem: string }
  | { withheld: "admin" | "missing" | "unreadable" | "old" };

export interface SourceMount {
  mountId: string;
  type: "bind" | "volume" | "file";
  hostPath?: string | null;
  volumeName?: string | null;
  volumeAlias?: string | null;
  filePath?: string | null;
  content?: string | null;
  mountPath: string;
  readOnly?: boolean | null;
}

export interface SourcePort {
  portId: string;
  publishedPort: number;
  targetPort: number;
  protocol?: string | null;
}

export interface SourceSecurity {
  securityId: string;
  username: string;
  password: string;
}

export interface SourceBackupSchedule {
  schedule?: string | null;
  enabled?: boolean | null;
  keepLatestCount?: number | null;
  destination?: { name?: string | null } | null;
  volumeName?: string | null;
  serviceName?: string | null;
  timezone?: string | null;
}

// A restore point the source can still restore from; only another Deplo sends them.
export interface SourceBackupRun {
  destination: string;
  objectKey: string;
  sizeBytes: number;
  decryptedSizeBytes?: number | null;
  sha256?: string | null;
  startedAt: string;
  finishedAt?: string | null;
}

// Every preview setting as Deplo stores it; null means Deplo's default.
export interface NativePreview {
  enabled: boolean;
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

export interface SourceApplication {
  // An uploaded archive the source hands over itself; null when there is none to fetch, absent when it never can.
  upload?: { filename: string; size: number } | null;
  backups?: SourceBackupSchedule[] | null;
  backupRuns?: SourceBackupRun[] | null;
  sharedRefs?: SharedRef[] | null;
  secretEnvKeys?: string[] | null;
  // Variables the source kept away from previews; absent means every one reaches both.
  productionOnlyEnvKeys?: string[] | null;
  platformNotes?: Note[] | null;
  healthCheck?: HealthCheck | null;
  // Settings already in Deplo's own shape, laid over what the platform-shaped fields map to.
  nativeBuild?: Partial<BuildConfig> | null;
  nativeResources?: Partial<ResourceLimits> | null;
  nativePreview?: NativePreview | null;
  // How each preview variable is typed; absent means the app's own secretEnvKeys decide.
  previewSecretEnvKeys?: string[] | null;
  // Whether its cron jobs run at all; absent when the source has no such switch.
  cronEnabled?: boolean | null;
  applicationId: string;
  name?: string | null;
  appName?: string | null;
  description?: string | null;
  env?: string | null;
  // Variables as pairs, exactly as the source held them; read before `env`, which is `.env` text.
  envEntries?: EnvPair[] | null;
  buildArgs?: string | null;
  icon?: string | null;
  sourceType: SourceOrigin;
  buildType: SourceBuildType;
  applicationStatus?: string | null;
  autoDeploy?: boolean | null;
  triggerType?: "push" | "tag" | null;
  watchPaths?: string[] | null;
  enableSubmodules?: boolean | null;
  replicas?: number | null;
  command?: string | null;
  installCommand?: string | null;
  buildCommand?: string | null;
  previewWildcard?: string | null;
  previewEnv?: string | null;
  previewEnvEntries?: EnvPair[] | null;
  dockerImage?: string | null;
  registryUrl?: string | null;
  registryId?: string | null;
  username?: string | null;
  dockerfile?: string | null;
  dockerContextPath?: string | null;
  dockerBuildStage?: string | null;
  publishDirectory?: string | null;
  isStaticSpa?: boolean | null;
  railpackVersion?: string | null;
  repository?: string | null;
  owner?: string | null;
  branch?: string | null;
  buildPath?: string | null;
  githubId?: string | null;
  gitlabRepository?: string | null;
  gitlabOwner?: string | null;
  gitlabBranch?: string | null;
  gitlabBuildPath?: string | null;
  gitlabPathNamespace?: string | null;
  gitlabId?: string | null;
  giteaRepository?: string | null;
  giteaOwner?: string | null;
  giteaBranch?: string | null;
  giteaBuildPath?: string | null;
  giteaId?: string | null;
  bitbucketRepository?: string | null;
  bitbucketRepositorySlug?: string | null;
  bitbucketOwner?: string | null;
  bitbucketBranch?: string | null;
  bitbucketBuildPath?: string | null;
  bitbucketId?: string | null;
  customGitUrl?: string | null;
  customGitBranch?: string | null;
  customGitBuildPath?: string | null;
  customGitSSHKeyId?: string | null;
  gitNeedsCredential?: boolean | null;
  isPreviewDeploymentsActive?: boolean | null;
  previewPort?: number | null;
  previewLimit?: number | null;
  healthCheckSwarm?: unknown;
  placementSwarm?: unknown;
  labelsSwarm?: unknown;
  ulimitsSwarm?: unknown;
  memoryLimit?: string | null;
  memoryReservation?: string | null;
  cpuLimit?: string | null;
  cpuReservation?: string | null;
  serverId?: string | null;
  environmentId?: string | null;
  routingPort?: number | null;
  domains?: SourceDomain[] | null;
  mounts?: SourceMount[] | null;
  ports?: SourcePort[] | null;
  security?: SourceSecurity[] | null;
  redirects?: { redirectId: string }[] | null;
  registry?: { registryId: string; registryName?: string | null } | null;
  github?: { githubId?: string; githubAppName?: string | null } | null;
  gitlab?: { gitlabId?: string; gitlabUrl?: string | null } | null;
  gitea?: { giteaId?: string; giteaUrl?: string | null } | null;
  bitbucket?: { bitbucketId?: string } | null;
}

export interface SourceCompose {
  backups?: SourceBackupSchedule[] | null;
  backupRuns?: SourceBackupRun[] | null;
  sharedRefs?: SharedRef[] | null;
  secretEnvKeys?: string[] | null;
  productionOnlyEnvKeys?: string[] | null;
  platformNotes?: Note[] | null;
  cronEnabled?: boolean | null;
  composeId: string;
  name?: string | null;
  appName?: string | null;
  description?: string | null;
  env?: string | null;
  envEntries?: EnvPair[] | null;
  composeFile?: string | null;
  icon?: string | null;
  composeType?: "docker-compose" | "stack" | null;
  stackDir?: string | null;
  routingPort?: number | null;
  sourceType: "git" | "github" | "gitlab" | "bitbucket" | "gitea" | "raw";
  composePath?: string | null;
  suffix?: string | null;
  randomize?: boolean | null;
  isolatedDeployment?: boolean | null;
  command?: string | null;
  autoDeploy?: boolean | null;
  serverId?: string | null;
  environmentId?: string | null;
  repository?: string | null;
  owner?: string | null;
  branch?: string | null;
  gitlabRepository?: string | null;
  gitlabOwner?: string | null;
  gitlabBranch?: string | null;
  giteaRepository?: string | null;
  giteaOwner?: string | null;
  giteaBranch?: string | null;
  bitbucketRepository?: string | null;
  bitbucketOwner?: string | null;
  bitbucketBranch?: string | null;
  customGitUrl?: string | null;
  customGitBranch?: string | null;
  domains?: SourceDomain[] | null;
  mounts?: SourceMount[] | null;
  github?: { githubId?: string; githubAppName?: string | null } | null;
  gitlab?: { gitlabId?: string; gitlabUrl?: string | null } | null;
  gitea?: { giteaId?: string; giteaUrl?: string | null } | null;
  bitbucket?: { bitbucketId?: string } | null;
}

export interface SourceDatabase {
  platformNotes?: Note[] | null;
  cronEnabled?: boolean | null;
  name?: string | null;
  appName?: string | null;
  description?: string | null;
  dockerImage?: string | null;
  backups?: SourceBackupSchedule[] | null;
  backupRuns?: SourceBackupRun[] | null;
  databaseName?: string | null;
  databaseUser?: string | null;
  databasePassword?: string | null;
  databaseRootPassword?: string | null;
  env?: string | null;
  command?: string | null;
  externalPort?: number | null;
  memoryLimit?: string | null;
  memoryReservation?: string | null;
  cpuLimit?: string | null;
  cpuReservation?: string | null;
  nativeResources?: Partial<ResourceLimits> | null;
  serverId?: string | null;
  environmentId?: string | null;
  mounts?: SourceMount[] | null;
  [idField: string]: unknown;
}

export const SOURCE_DB_KINDS = [
  "postgres",
  "mysql",
  "mariadb",
  "mongo",
  "redis",
  "libsql",
  "clickhouse",
  "keydb",
  "dragonfly",
  "unknown",
] as const;
export type SourceDbKind = (typeof SOURCE_DB_KINDS)[number];

export interface SourceSharedEnv {
  env?: string | null;
  envEntries?: EnvPair[] | null;
  secretEnvKeys?: string[] | null;
}

export interface SourceEnvironment {
  environmentId: string;
  name: string;
  description?: string | null;
  env?: string | null;
  envEntries?: EnvPair[] | null;
  secretEnvKeys?: string[] | null;
  platformNotes?: Note[] | null;
  isDefault?: boolean | null;
  kind?: EnvironmentKind;
  gitBranch?: string;
  applications?: SourceApplication[] | null;
  compose?: SourceCompose[] | null;
  postgres?: SourceDatabase[] | null;
  mysql?: SourceDatabase[] | null;
  mariadb?: SourceDatabase[] | null;
  mongo?: SourceDatabase[] | null;
  redis?: SourceDatabase[] | null;
  libsql?: SourceDatabase[] | null;
  clickhouse?: SourceDatabase[] | null;
  keydb?: SourceDatabase[] | null;
  dragonfly?: SourceDatabase[] | null;
  unknown?: SourceDatabase[] | null;
}

export interface SourceProject {
  projectId: string;
  name: string;
  color?: string | null;
  description?: string | null;
  env?: string | null;
  envEntries?: EnvPair[] | null;
  secretEnvKeys?: string[] | null;
  platformNotes?: Note[] | null;
  createdAt?: string | null;
  environments?: SourceEnvironment[] | null;
  applications?: SourceApplication[] | null;
  compose?: SourceCompose[] | null;
  postgres?: SourceDatabase[] | null;
  mysql?: SourceDatabase[] | null;
  mariadb?: SourceDatabase[] | null;
  mongo?: SourceDatabase[] | null;
  redis?: SourceDatabase[] | null;
  libsql?: SourceDatabase[] | null;
  clickhouse?: SourceDatabase[] | null;
  keydb?: SourceDatabase[] | null;
  dragonfly?: SourceDatabase[] | null;
  unknown?: SourceDatabase[] | null;
}

export interface SourceServer {
  serverId: string;
  name: string;
  ipAddress?: string | null;
  description?: string | null;
}

export interface SourceMember {
  id?: string;
  userId?: string;
  role?: string | null;
  user?: {
    id?: string;
    email?: string | null;
    name?: string | null;
    firstName?: string | null;
    lastName?: string | null;
    image?: string | null;
  } | null;
  email?: string | null;
  name?: string | null;
  firstName?: string | null;
  lastName?: string | null;
}

export interface SourceSchedule {
  scheduleId: string;
  name: string;
  cronExpression: string;
  shellType?: string | null;
  command?: string | null;
  script?: string | null;
  serviceName?: string | null;
  scheduleType?: string | null;
  enabled?: boolean | null;
  env?: EnvPair[] | null;
  // The rest of a job already in Deplo's own shape.
  native?: SourceCronSettings | null;
}

export interface SourceCronSettings {
  description?: string;
  timezone?: string;
  shell?: string;
  timeoutSeconds?: number;
  maxAttempts?: number;
  overlap?: string;
  keepRuns?: number;
  workdir?: string | null;
  user?: string | null;
}

export interface NamedVolume {
  name: string;
  mountPath: string;
  alias?: string;
}

export interface HostMount {
  hostPath: string;
  mountPath: string;
  stackRelative?: boolean;
}

export interface SourceS3Destination {
  kind?: "s3";
  name: string;
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  provider?: string | null;
  // The key its artifacts are encrypted to; null when it never encrypted, absent when unknown.
  ageIdentity?: string | null;
}

export interface SourceServerDestination {
  kind: "server";
  name: string;
  serverId: string;
  serverName: string | null;
  path: string | null;
  ageIdentity?: string;
}

export type SourceBackupDestination =
  SourceS3Destination | SourceServerDestination;
