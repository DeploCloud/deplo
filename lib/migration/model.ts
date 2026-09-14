import type { HealthCheck } from "../types/container";
import type { SharedRef } from "./map/env";

// Dokploy's build packs. `heroku_buildpacks`/`paketo_buildpacks` have no Deplo twin.
export type SourceBuildType =
  | "dockerfile"
  | "heroku_buildpacks"
  | "paketo_buildpacks"
  | "nixpacks"
  | "static"
  | "railpack";

// Where an application's code comes from. `drop` is an uploaded archive.
export type SourceOrigin =
  "docker" | "git" | "github" | "gitlab" | "bitbucket" | "gitea" | "drop";

export interface SourceDomain {
  domainId: string;
  host: string;
  https?: boolean | null;
  port?: number | null;
  path?: string | null;
  stripPath?: boolean | null;
  // The path the request is rewritten TO (Dokploy middleware); Deplo has no third answer, so a real rewrite is reported.
  internalPath?: string | null;
  serviceName?: string | null;
  // Deplo has two entrypoints (web, websecure), so anything else is reported, not silently replaced.
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
  // The volume without the panel's own id in front of it; `volumeName` stays the name on the SOURCE host.
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

// One basic-auth credential. Dokploy stores the password in the clear.
export interface SourceSecurity {
  securityId: string;
  username: string;
  password: string;
}

// A backup schedule the panel kept for a service: a database dump, or a volume.
export interface SourceBackupSchedule {
  schedule?: string | null;
  enabled?: boolean | null;
  keepLatestCount?: number | null;
  destination?: { name?: string | null } | null;
  // The one volume a VOLUME backup covered; a dump names none.
  volumeName?: string | null;
  // For a dump taken inside a stack: the compose service it ran against.
  serviceName?: string | null;
}

export interface SourceApplication {
  // Volume backups the panel scheduled for it (Dokploy: `volumeBackups`).
  backups?: SourceBackupSchedule[] | null;
  // A WHOLE-value reference of the same name becomes a LINK rather than a copy; anything else is resolved to a value.
  sharedRefs?: SharedRef[] | null;
  // Keys the PANEL marked write-only (Coolify "shown once"). Deplo never guesses one.
  secretEnvKeys?: string[] | null;
  // Platform-specific findings with no home in Deplo. Written with `{panel}` where the product's name goes.
  platformNotes?: string[] | null;
  // The health check the source ran, when it has a twin here.
  healthCheck?: HealthCheck | null;
  applicationId: string;
  // OPTIONAL because `project.all` is a projection: a real value comes from the DETAIL row (`getService`).
  name?: string | null;
  appName?: string | null;
  description?: string | null;
  env?: string | null;
  buildArgs?: string | null;
  // ALWAYS a base64 data-URI rather than a URL: the panel inlines the logo server-side.
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
  // Build-step overrides where the panel has them (Coolify); null = detect.
  installCommand?: string | null;
  buildCommand?: string | null;
  previewWildcard?: string | null;
  previewEnv?: string | null;
  dockerImage?: string | null;
  registryUrl?: string | null;
  registryId?: string | null;
  // The password is excluded from the API, so only the fact that there IS a credential comes across.
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
  // Absent means the source cloned anonymously, which Deplo can do too.
  gitNeedsCredential?: boolean | null;
  isPreviewDeploymentsActive?: boolean | null;
  previewPort?: number | null;
  previewLimit?: number | null;
  // swarm-only knobs, reported rather than imported
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
  // A domain that carries no port of its own routes here rather than to Deplo's default.
  routingPort?: number | null;
  // relations, present on `application.one`
  domains?: SourceDomain[] | null;
  mounts?: SourceMount[] | null;
  ports?: SourcePort[] | null;
  security?: SourceSecurity[] | null;
  redirects?: { redirectId: string }[] | null;
  registry?: { registryId: string; registryName?: string | null } | null;
  // Every credential column is excluded server-side; these carry the one thing the import cannot guess: the self-hosted HOST.
  github?: { githubId?: string; githubAppName?: string | null } | null;
  gitlab?: { gitlabId?: string; gitlabUrl?: string | null } | null;
  gitea?: { giteaId?: string; giteaUrl?: string | null } | null;
  bitbucket?: { bitbucketId?: string } | null;
}

export interface SourceCompose {
  // Volume backups and in-stack database dumps the panel scheduled for it.
  backups?: SourceBackupSchedule[] | null;
  // A WHOLE-value reference of the same name becomes a LINK rather than a copy; anything else is resolved to a value.
  sharedRefs?: SharedRef[] | null;
  // Keys the PANEL marked write-only (Coolify "shown once"). Deplo never guesses one.
  secretEnvKeys?: string[] | null;
  // Platform-specific findings with no home in Deplo. Written with `{panel}` where the product's name goes.
  platformNotes?: string[] | null;
  composeId: string;
  // Optional for the same reason as `SourceApplication.name`.
  name?: string | null;
  appName?: string | null;
  description?: string | null;
  env?: string | null;
  composeFile?: string | null;
  // ALWAYS a base64 data-URI rather than a URL: the panel inlines the logo server-side.
  icon?: string | null;
  composeType?: "docker-compose" | "stack" | null;
  // What a `./x` bind resolves against on the SOURCE machine; Dokploy answers with nothing, so a running container names it.
  stackDir?: string | null;
  // What a route with no port of its own reaches; a stack route with none renders no Traefik router at all.
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

// The five database engines share one shape; only the id field's name differs.
export interface SourceDatabase {
  // Platform-specific findings with no home in Deplo. Written with `{panel}` where the product's name goes.
  platformNotes?: string[] | null;
  // A database row from `project.all` really does carry NOTHING but its id.
  name?: string | null;
  appName?: string | null;
  description?: string | null;
  dockerImage?: string | null;
  // The panel's own backup schedules for it, where the detail row carries them.
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

// Every per-engine key an environment can carry; Deplo's own spellings win where they differ (`postgres`, `mongo`).
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
  // The panel would not say which engine: kept so it reaches the report, never dropped in silence.
  "unknown",
] as const;
export type SourceDbKind = (typeof SOURCE_DB_KINDS)[number];

// A shared-variable level as the panel hands it over: the blob, and the keys it marked write-only.
export interface SourceSharedEnv {
  env: string;
  secretEnvKeys?: string[] | null;
}

export interface SourceEnvironment {
  environmentId: string;
  name: string;
  description?: string | null;
  env?: string | null;
  // Keys the panel marked write-only at this level - see `SourceApplication.secretEnvKeys`.
  secretEnvKeys?: string[] | null;
  // What the panel would not answer for at THIS level. Written with `{panel}`.
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
  // Keys the panel marked write-only at this level - see `SourceApplication.secretEnvKeys`.
  secretEnvKeys?: string[] | null;
  // What the panel would not answer for at THIS level. Written with `{panel}`.
  platformNotes?: string[] | null;
  createdAt?: string | null;
  environments?: SourceEnvironment[] | null;
  // Pre-environments Dokploy hung services straight off the project; `listProjects` folds them into a synthetic one.
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

// A member of the organization the API key belongs to.
export interface SourceMember {
  id?: string;
  userId?: string;
  role?: string | null;
  user?: {
    id?: string;
    email?: string | null;
    // Dokploy puts the ACCOUNT here, which is the address - the person's own name is in `firstName`.
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

// One named volume a container is using, on either side.
export interface NamedVolume {
  // The volume's real name on the host, not the compose key.
  name: string;
  mountPath: string;
  // Two services mounting the same path is ordinary; the same alias twice is not.
  alias?: string;
}

// One host directory a container mounts: the bind-mount counterpart of a NamedVolume.
export interface HostMount {
  hostPath: string;
  mountPath: string;
  // Written as `./x`, so the path is the stack's OWN directory on whichever machine holds it, never one somebody typed.
  stackRelative?: boolean;
}

// One S3 store the source platform backs up to.
export interface SourceS3Destination {
  name: string;
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}
