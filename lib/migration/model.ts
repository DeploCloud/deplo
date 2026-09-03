import type { HealthCheck } from "../types";
import type { SharedRef } from "./map";

/**
 * The row shapes an import maps, shared by every source platform.
 *
 * They started as Dokploy's, and Coolify's rows fold onto them: an adapter's job
 * is to answer in these, so the mapper and the importer never learn which panel
 * they are reading.
 */
/* ------------------------------------------------------------------ */
/* Row shapes - only the fields the import actually maps               */
/* ------------------------------------------------------------------ */

/** Dokploy's build packs. `heroku_buildpacks`/`paketo_buildpacks` have no Deplo twin. */
export type SourceBuildType =
  | "dockerfile"
  | "heroku_buildpacks"
  | "paketo_buildpacks"
  | "nixpacks"
  | "static"
  | "railpack";

/** Where an application's code comes from. `drop` is an uploaded archive. */
export type SourceOrigin =
  "docker" | "git" | "github" | "gitlab" | "bitbucket" | "gitea" | "drop";

export interface SourceDomain {
  domainId: string;
  host: string;
  https?: boolean | null;
  port?: number | null;
  path?: string | null;
  stripPath?: boolean | null;
  /**
   * The path the request is rewritten TO before it reaches the container
   * (Dokploy's own middleware). Deplo strips a prefix or forwards it whole and has
   * no third answer, so a real rewrite is reported rather than silently dropped.
   */
  internalPath?: string | null;
  serviceName?: string | null;
  /** The Traefik entrypoint the route was bound to over there. Deplo has two
   *  (web, websecure), so anything else is reported, not silently replaced. */
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
  /** The same volume without the panel's own id in front of it: what the owner
   *  reads in Storage. `volumeName` stays the name on the SOURCE host. */
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

/** One basic-auth credential. Dokploy stores the password in the clear. */
export interface SourceSecurity {
  securityId: string;
  username: string;
  password: string;
}

export interface SourceApplication {
  /**
   * Shared variables this service's own values reference (`{{team.KEY}}` /
   * `${{project.KEY}}`). A WHOLE-value reference of the same name becomes a LINK
   * here rather than a copy; anything else is resolved to a value.
   */
  sharedRefs?: SharedRef[] | null;
  /**
   * What the ADAPTER found that no shared mapper can see: a platform-specific
   * field with no home in Deplo. Written with `{panel}` where the product's name
   * goes, like every other note.
   */
  platformNotes?: string[] | null;
  /** The health check the source ran, when it has a twin here. */
  healthCheck?: HealthCheck | null;
  applicationId: string;
  /** OPTIONAL because `project.all` is a projection: its rows carry an id and
   *  sometimes a name, and a database row carries only the id. Anything that needs
   *  a real value reads the DETAIL row (`getService`). */
  name?: string | null;
  appName?: string | null;
  description?: string | null;
  env?: string | null;
  buildArgs?: string | null;
  /**
   * The service's icon, and ALWAYS a base64 data-URI rather than a URL: Dokploy
   * inlines a template's logo server-side when the service is created, an upload
   * is read with `FileReader`, and its bundled icon set is an SVG built in the
   * browser.
   */
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
  /** Build-step overrides where the panel has them (Coolify); null = detect. */
  installCommand?: string | null;
  buildCommand?: string | null;
  /** Preview deployments' base domain and their own variables, where the panel has them. */
  previewWildcard?: string | null;
  previewEnv?: string | null;
  // docker source
  dockerImage?: string | null;
  registryUrl?: string | null;
  registryId?: string | null;
  /** The docker-provider credentials typed onto the app itself. The password is
   *  excluded from the API, so only the fact that there IS one comes across. */
  username?: string | null;
  // dockerfile / static build settings
  dockerfile?: string | null;
  dockerContextPath?: string | null;
  dockerBuildStage?: string | null;
  publishDirectory?: string | null;
  isStaticSpa?: boolean | null;
  railpackVersion?: string | null;
  // github
  repository?: string | null;
  owner?: string | null;
  branch?: string | null;
  buildPath?: string | null;
  githubId?: string | null;
  // gitlab
  gitlabRepository?: string | null;
  gitlabOwner?: string | null;
  gitlabBranch?: string | null;
  gitlabBuildPath?: string | null;
  gitlabPathNamespace?: string | null;
  gitlabId?: string | null;
  // gitea
  giteaRepository?: string | null;
  giteaOwner?: string | null;
  giteaBranch?: string | null;
  giteaBuildPath?: string | null;
  giteaId?: string | null;
  // bitbucket
  bitbucketRepository?: string | null;
  bitbucketRepositorySlug?: string | null;
  bitbucketOwner?: string | null;
  bitbucketBranch?: string | null;
  bitbucketBuildPath?: string | null;
  bitbucketId?: string | null;
  // plain git
  customGitUrl?: string | null;
  customGitBranch?: string | null;
  customGitBuildPath?: string | null;
  customGitSSHKeyId?: string | null;
  /**
   * The source needed a CREDENTIAL to clone this - a connected account or a
   * deploy key. Absent means it cloned anonymously, which Deplo can do too.
   */
  gitNeedsCredential?: boolean | null;
  // preview deployments (Deplo has the same feature)
  isPreviewDeploymentsActive?: boolean | null;
  previewPort?: number | null;
  previewLimit?: number | null;
  // swarm-only knobs, reported rather than imported
  healthCheckSwarm?: unknown;
  placementSwarm?: unknown;
  labelsSwarm?: unknown;
  ulimitsSwarm?: unknown;
  // limits
  memoryLimit?: string | null;
  memoryReservation?: string | null;
  cpuLimit?: string | null;
  cpuReservation?: string | null;
  // placement
  serverId?: string | null;
  environmentId?: string | null;
  /**
   * The port the app LISTENS on, when the platform records one of its own. A
   * domain that carries no port routes here rather than to Deplo's default.
   */
  routingPort?: number | null;
  // relations, present on `application.one`
  domains?: SourceDomain[] | null;
  mounts?: SourceMount[] | null;
  ports?: SourcePort[] | null;
  security?: SourceSecurity[] | null;
  redirects?: { redirectId: string }[] | null;
  registry?: { registryId: string; registryName?: string | null } | null;
  /**
   * The git provider rows, with every credential column excluded server-side
   * (`columns: { accessToken: false, … }`). They carry the one thing the import
   * needs and cannot guess: the HOST of a self-hosted GitLab/Gitea.
   */
  github?: { githubId?: string; githubAppName?: string | null } | null;
  gitlab?: { gitlabId?: string; gitlabUrl?: string | null } | null;
  gitea?: { giteaId?: string; giteaUrl?: string | null } | null;
  bitbucket?: { bitbucketId?: string } | null;
}

export interface SourceCompose {
  /**
   * Shared variables this service's own values reference (`{{team.KEY}}` /
   * `${{project.KEY}}`). A WHOLE-value reference of the same name becomes a LINK
   * here rather than a copy; anything else is resolved to a value.
   */
  sharedRefs?: SharedRef[] | null;
  /**
   * What the ADAPTER found that no shared mapper can see: a platform-specific
   * field with no home in Deplo. Written with `{panel}` where the product's name
   * goes, like every other note.
   */
  platformNotes?: string[] | null;
  composeId: string;
  /** Optional for the same reason as {@link SourceApplication.name}. */
  name?: string | null;
  appName?: string | null;
  description?: string | null;
  env?: string | null;
  composeFile?: string | null;
  /**
   * The service's icon, and ALWAYS a base64 data-URI rather than a URL: Dokploy
   * inlines a template's logo server-side when the service is created, an upload
   * is read with `FileReader`, and its bundled icon set is an SVG built in the
   * browser.
   */
  icon?: string | null;
  composeType?: "docker-compose" | "stack" | null;
  /**
   * Where this stack's own directory sits on the SOURCE machine - what a `./x`
   * bind in its compose resolves against. Coolify keeps it under its data dir;
   * Dokploy answers with nothing, and a running container names it instead.
   */
  stackDir?: string | null;
  /** Same as {@link SourceApplication.routingPort}: what a route with no port of
   *  its own reaches. A stack route with none renders no Traefik router at all. */
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
  // git fields, same per-provider spread as an application
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

/** The five database engines share one shape; only the id field's name differs. */
export interface SourceDatabase {
  /**
   * What the ADAPTER found that no shared mapper can see: a platform-specific
   * field with no home in Deplo. Written with `{panel}` where the product's name
   * goes, like every other note.
   */
  platformNotes?: string[] | null;
  /** Optional for the same reason as {@link SourceApplication.name}, and a
   *  database row from `project.all` really does carry NOTHING but its id. */
  name?: string | null;
  appName?: string | null;
  description?: string | null;
  dockerImage?: string | null;
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

/**
 * Every per-engine key an environment can carry, across both platforms. Deplo's
 * own spellings win where they differ (`postgres`, `mongo`), so a report and a
 * pairing read the same whichever panel a run came from.
 */
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
  /** The panel would not say which engine it runs. Kept so it reaches the plan
   *  and the report as a database nobody could import, never dropped in silence. */
  "unknown",
] as const;
export type SourceDbKind = (typeof SOURCE_DB_KINDS)[number];

export interface SourceEnvironment {
  environmentId: string;
  name: string;
  description?: string | null;
  env?: string | null;
  /** What the panel would not answer for at THIS level. Written with `{panel}`. */
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
  /** What the panel would not answer for at THIS level. Written with `{panel}`. */
  platformNotes?: string[] | null;
  createdAt?: string | null;
  environments?: SourceEnvironment[] | null;
  /**
   * Pre-environments Dokploy hung services straight off the project. Kept so an
   * older instance still scans; `listProjects` folds them into a synthetic
   * environment.
   */
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

/** A member of the organization the API key belongs to. */
export interface SourceMember {
  id?: string;
  userId?: string;
  role?: string | null;
  user?: {
    id?: string;
    email?: string | null;
    /** Dokploy puts the ACCOUNT here, which is the address - the person's own
     *  name is in {@link SourceMember.firstName}. */
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

/** One named volume a container is using, on either side. */
export interface NamedVolume {
  /** The volume's real name on the host. */
  name: string;
  /** Where it is mounted INSIDE the container. */
  mountPath: string;
  /** The alias the compose file gave it, when the file itself is known. Two
   *  services mounting the same path is ordinary; the same alias twice is not. */
  alias?: string;
}

/** One host directory a container mounts: where it is on the host, and where the
 *  container sees it. The bind-mount counterpart of a NamedVolume. */
export interface HostMount {
  hostPath: string;
  mountPath: string;
  /**
   * The compose file wrote this as `./x`, so the path is the stack's OWN
   * directory on whichever machine holds it - never one somebody typed.
   */
  stackRelative?: boolean;
}

/** One S3 store the source platform backs up to. */
export interface SourceS3Destination {
  name: string;
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}
