import type { HealthCheck } from "../types/container";
import type { SharedRef } from "./map/env";

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
}

export interface SourceMount {
  mountId: string;
  type: "bind" | "volume" | "file";
  hostPath?: string | null;
  volumeName?: string | null;
  volumeAlias?: string | null;
  filePath?: string | null;
  content?: string | null;
  mountPath: string;
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
}

export interface SourceApplication {
  backups?: SourceBackupSchedule[] | null;
  sharedRefs?: SharedRef[] | null;
  secretEnvKeys?: string[] | null;
  platformNotes?: string[] | null;
  healthCheck?: HealthCheck | null;
  applicationId: string;
  name?: string | null;
  appName?: string | null;
  description?: string | null;
  env?: string | null;
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
  sharedRefs?: SharedRef[] | null;
  secretEnvKeys?: string[] | null;
  platformNotes?: string[] | null;
  composeId: string;
  name?: string | null;
  appName?: string | null;
  description?: string | null;
  env?: string | null;
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
  platformNotes?: string[] | null;
  name?: string | null;
  appName?: string | null;
  description?: string | null;
  dockerImage?: string | null;
  backups?: SourceBackupSchedule[] | null;
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
  env: string;
  secretEnvKeys?: string[] | null;
}

export interface SourceEnvironment {
  environmentId: string;
  name: string;
  description?: string | null;
  env?: string | null;
  secretEnvKeys?: string[] | null;
  platformNotes?: string[] | null;
  isDefault?: boolean | null;
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
  description?: string | null;
  env?: string | null;
  secretEnvKeys?: string[] | null;
  platformNotes?: string[] | null;
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
  name: string;
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}
