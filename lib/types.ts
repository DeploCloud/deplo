/**
 * Deplo domain model.
 * Plain serializable types shared by the data layer, server actions and UI.
 * Secret fields are stored encrypted at rest and never sent to the client raw.
 */

export type ID = string;

export type Role = "owner" | "member" | "viewer";

export interface User {
  id: ID;
  email: string;
  name: string;
  /** scrypt hash, never leaves the server */
  passwordHash: string;
  role: Role;
  avatarColor: string;
  createdAt: string;
}

/** DTO safe to send to the client. */
export interface PublicUser {
  id: ID;
  email: string;
  name: string;
  role: Role;
  avatarColor: string;
}

export interface Team {
  id: ID;
  name: string;
  slug: string;
  plan: "hobby" | "pro" | "enterprise";
  createdAt: string;
}

export type ServerStatus = "online" | "offline" | "provisioning" | "error";

export interface Server {
  id: ID;
  name: string;
  /** "localhost" for the host running Deplo, or a remote IP/host */
  host: string;
  type: "localhost" | "remote";
  status: ServerStatus;
  ip: string;
  dockerVersion: string;
  traefikEnabled: boolean;
  cpuCores: number;
  memoryMb: number;
  diskGb: number;
  /** live-ish metrics 0-100 */
  cpuUsage: number;
  memoryUsage: number;
  diskUsage: number;
  createdAt: string;
}

export type FrameworkId =
  | "nextjs"
  | "svelte"
  | "sveltekit"
  | "astro"
  | "vite"
  | "remix"
  | "nuxt"
  | "react"
  | "vue"
  | "angular"
  | "gatsby"
  | "static"
  | "node"
  | "python"
  | "go"
  | "rust"
  | "php"
  | "docker"
  | "other";

export type ProjectStatus = "active" | "building" | "error" | "queued" | "idle";

/**
 * Where a project's code/image comes from. Mirrors the choices offered by
 * Coolify / Dokploy / Easypanel:
 *  - github      a connected GitHub repository (auto-deploy on push)
 *  - git         any public/private Git URL
 *  - docker-image a prebuilt image from a registry (no build step)
 *  - dockerfile  build from a Dockerfile in the repo
 *  - upload      a code archive uploaded from the dashboard
 */
export type DeploySource =
  | "github"
  | "git"
  | "docker-image"
  | "dockerfile"
  | "upload";

export interface GitRepo {
  provider: "github" | "gitlab" | "bitbucket" | "git";
  url: string;
  repo: string; // owner/name
  branch: string;
}

export interface BuildConfig {
  framework: FrameworkId;
  rootDirectory: string;
  installCommand: string;
  buildCommand: string;
  outputDirectory: string;
  startCommand: string;
  nodeVersion: string;
  port: number;
}

export interface Project {
  id: ID;
  name: string;
  slug: string;
  teamId: ID;
  serverId: ID;
  framework: FrameworkId;
  /** How this project is deployed (git, docker image, dockerfile, upload). */
  source: DeploySource;
  repo: GitRepo | null;
  /** Image reference when source is "docker-image" (e.g. ghcr.io/org/app:tag). */
  dockerImage: string | null;
  /** Editable docker-compose stack for template/compose deploys (else null). */
  compose: string | null;
  build: BuildConfig;
  productionUrl: string | null;
  status: ProjectStatus;
  autoDeploy: boolean;
  latestDeploymentId: ID | null;
  createdAt: string;
  updatedAt: string;
}

export type DeploymentStatus =
  | "queued"
  | "building"
  | "ready"
  | "error"
  | "canceled";

export type DeploymentEnvironment = "production" | "preview";

export interface Deployment {
  id: ID;
  projectId: ID;
  status: DeploymentStatus;
  environment: DeploymentEnvironment;
  commitSha: string;
  commitMessage: string;
  commitAuthor: string;
  branch: string;
  url: string;
  createdAt: string;
  readyAt: string | null;
  buildDurationMs: number | null;
  creator: string;
}

export type LogLevel = "info" | "warn" | "error" | "debug" | "command";

export interface LogLine {
  ts: string;
  level: LogLevel;
  text: string;
}

export type EnvTarget = "production" | "preview" | "development";

export interface EnvVar {
  id: ID;
  projectId: ID;
  key: string;
  /** encrypted at rest */
  valueEnc: string;
  targets: EnvTarget[];
  type: "plain" | "secret";
  createdAt: string;
  updatedAt: string;
}

/** DTO sent to client: secret values are masked. */
export interface EnvVarDTO {
  id: ID;
  key: string;
  value: string; // masked for secrets unless explicitly revealed
  masked: boolean;
  targets: EnvTarget[];
  type: "plain" | "secret";
  updatedAt: string;
}

export type DomainStatus = "valid" | "pending" | "misconfigured" | "error";

export interface Domain {
  id: ID;
  projectId: ID;
  name: string;
  status: DomainStatus;
  primary: boolean;
  redirectTo: string | null;
  ssl: boolean;
  createdAt: string;
}

export type DatabaseType =
  | "postgres"
  | "mysql"
  | "mariadb"
  | "mongodb"
  | "redis"
  | "clickhouse";

export type DatabaseStatus = "running" | "stopped" | "provisioning" | "error";

export interface Database {
  id: ID;
  name: string;
  type: DatabaseType;
  version: string;
  status: DatabaseStatus;
  serverId: ID;
  host: string;
  port: number;
  /** encrypted at rest */
  connectionStringEnc: string;
  exposedPublicly: boolean;
  sizeMb: number;
  createdAt: string;
}

export type S3Provider =
  | "aws"
  | "cloudflare-r2"
  | "backblaze-b2"
  | "minio"
  | "digitalocean"
  | "wasabi"
  | "other";

export type S3Status = "connected" | "error" | "unverified";

export interface S3Destination {
  id: ID;
  name: string;
  provider: S3Provider;
  endpoint: string;
  region: string;
  bucket: string;
  /** encrypted at rest */
  accessKeyEnc: string;
  secretKeyEnc: string;
  status: S3Status;
  createdAt: string;
}

export interface Backup {
  id: ID;
  name: string;
  databaseId: ID | null;
  destinationId: ID;
  schedule: string; // cron
  retentionDays: number;
  lastRunAt: string | null;
  lastStatus: "success" | "failed" | "running" | "never";
  enabled: boolean;
  createdAt: string;
}

export interface ApiToken {
  id: ID;
  name: string;
  /** sha256 of the token; raw is shown once on creation */
  tokenHash: string;
  prefix: string;
  lastUsedAt: string | null;
  createdAt: string;
}

export type ActivityType =
  | "deployment"
  | "project"
  | "database"
  | "domain"
  | "env"
  | "member"
  | "backup"
  | "s3";

export interface Activity {
  id: ID;
  type: ActivityType;
  message: string;
  actor: string;
  projectId: ID | null;
  createdAt: string;
}

export interface SharedEnvVar {
  key: string;
  /** encrypted at rest */
  valueEnc: string;
  type: "plain" | "secret";
}

/**
 * A reusable set of environment variables defined once and attached to many
 * projects (Coolify-style "shared variables"). Attached projects reference the
 * single global value, so editing it here updates every attached project.
 */
export interface SharedEnvGroup {
  id: ID;
  name: string;
  description: string;
  variables: SharedEnvVar[];
  /** ids of the projects this group is attached to */
  projectIds: ID[];
  createdAt: string;
  updatedAt: string;
}

export type RegistryType = "ghcr" | "dockerhub" | "gitlab" | "generic";

/** A container image registry used to pull/push images for deployments. */
export interface Registry {
  id: ID;
  name: string;
  type: RegistryType;
  /** registry host, e.g. ghcr.io, docker.io, registry.gitlab.com */
  registryUrl: string;
  username: string;
  /** encrypted at rest (password or access token) */
  passwordEnc: string;
  createdAt: string;
}

/**
 * Notification / anomaly-alert configuration. Deplo can deliver alerts through
 * browser push, email, a Discord webhook and a generic outbound webhook; the
 * `events` map decides which conditions actually fire an alert.
 */
export type NotificationChannel = "push" | "email" | "discord" | "webhook";

export type NotificationEvent =
  | "deployment_failed"
  | "deployment_succeeded"
  | "server_offline"
  | "high_resource_usage"
  | "update_available";

export interface NotificationSettings {
  channels: {
    push: { enabled: boolean };
    email: { enabled: boolean; address: string };
    discord: { enabled: boolean; webhookUrl: string };
    webhook: { enabled: boolean; url: string };
  };
  events: Record<NotificationEvent, boolean>;
}

/** Whole persisted database shape. */
export interface DeploData {
  users: User[];
  teams: Team[];
  servers: Server[];
  projects: Project[];
  deployments: Deployment[];
  logs: Record<ID, LogLine[]>; // by deploymentId
  envVars: EnvVar[];
  domains: Domain[];
  databases: Database[];
  s3Destinations: S3Destination[];
  backups: Backup[];
  apiTokens: ApiToken[];
  activities: Activity[];
  notificationSettings: NotificationSettings;
  sharedEnvGroups: SharedEnvGroup[];
  registries: Registry[];
}
