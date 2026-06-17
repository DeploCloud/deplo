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
 * Coolify / Dokploy / Easypanel. How the code is turned into an image is a
 * separate axis — see BuildConfig.buildMethod (which includes "dockerfile").
 *  - github      a connected GitHub repository (auto-deploy on push)
 *  - git         any public/private Git URL
 *  - docker-image a prebuilt image from a registry (no build step)
 *  - upload      a code archive uploaded from the dashboard
 *  - compose     a multi-service docker-compose stack (template / hand-written)
 */
export type DeploySource =
  | "github"
  | "git"
  | "docker-image"
  | "upload"
  | "compose";

/**
 * A code archive uploaded from the dashboard, backing an "upload" source. The
 * tarball/zip is written to DATA_DIR/uploads/<projectId>/<id><ext> and built
 * exactly like a git clone (extract → resolve rootDirectory → build method).
 */
export interface UploadArchive {
  /** Opaque id, also the on-disk basename (minus extension). */
  id: ID;
  /** Original filename as uploaded, for display (e.g. "my-app.tar.gz"). */
  filename: string;
  /** Absolute path to the stored archive on the host running Deplo. */
  path: string;
  /** Size in bytes, for display. */
  size: number;
  uploadedAt: string;
}

export interface GitRepo {
  provider: "github" | "gitlab" | "bitbucket" | "git";
  url: string;
  repo: string; // owner/name
  branch: string;
  /**
   * For private GitHub repos cloned through a connected GitHub App: the id of
   * the installation whose short-lived token authenticates the clone. Absent
   * for public repos or plain Git URLs.
   */
  installationId?: string | null;
}

/**
 * How Deplo turns a repository into a runnable image — orthogonal to the
 * framework preset (which only seeds the install/build/output commands). Mirrors
 * the "build pack" choice in Coolify/Dokploy/Railway. Each method runs entirely
 * inside Docker (the only build tool guaranteed present on the host):
 *  - dockerfile  build straight from a Dockerfile in the repo
 *  - railpack    Railway's BuildKit-based builder (Nixpacks' successor)
 *  - nixpacks    Nixpacks auto-detects and builds an OCI image
 *  - heroku      Cloud Native Buildpacks with the Heroku builder
 *  - paketo      Cloud Native Buildpacks with the Paketo builder
 *  - static      build (if needed) then serve the output dir with nginx
 */
export type BuildMethod =
  | "dockerfile"
  | "railpack"
  | "nixpacks"
  | "heroku"
  | "paketo"
  | "static";

/**
 * Per-method build settings. All optional/defaulted; only the fields relevant to
 * the active `buildMethod` are surfaced in the UI and consumed at deploy time.
 */
export interface BuildMethodSettings {
  /** dockerfile: path to the Dockerfile, relative to the repo root. */
  dockerfilePath?: string;
  /** dockerfile: build context dir, relative to the repo root. */
  dockerContextPath?: string;
  /** dockerfile: optional `--target` build stage in a multi-stage Dockerfile. */
  dockerBuildStage?: string;
  /** railpack: builder image tag (e.g. "latest", "0.7"). */
  railpackVersion?: string;
  /** nixpacks: directory the build publishes / serves (informational + static). */
  nixpacksPublishDirectory?: string;
  /** heroku: builder image tag mapped to heroku/builder:<version> (e.g. "24"). */
  herokuVersion?: string;
  /** static: serve as a single-page app (SPA history-API fallback to index.html). */
  staticSinglePageApp?: boolean;
}

export interface BuildConfig {
  framework: FrameworkId;
  /** Which builder turns the repo into an image. Defaults to "nixpacks". */
  buildMethod: BuildMethod;
  /** Settings scoped to the active build method (see BuildMethodSettings). */
  methodSettings: BuildMethodSettings;
  rootDirectory: string;
  installCommand: string;
  buildCommand: string;
  outputDirectory: string;
  startCommand: string;
  /**
   * Pinned runtime version for the framework's language (Node, Python, Go, …).
   * Interpreted per language by the builder; empty means "use the builder's
   * default". The UI labels it per language (see runtimeFor).
   */
  runtimeVersion: string;
  port: number;
}

/**
 * Push-only lifecycle state of a project's dev container. Never reconciled
 * against live docker (there is no monitor loop) — exactly like
 * `ProjectStatus`, with the same known consequence that a manually-stopped
 * container can show a stale status.
 */
export type DevStatus = "off" | "starting" | "running" | "stopped" | "error";

/**
 * Coarse base-language image a dev container runs on. A *different, coarser*
 * axis than `FrameworkId` (app type) and `runtimeVersion` (language version):
 * a Next.js project's preset is `node`. Derived by default from `framework`;
 * resolves to an OFFICIAL base image (node:22, python:3.12, …) used directly.
 */
export type DevImagePreset = "node" | "python" | "go" | "rust" | "php" | "java";

/**
 * The runtime a port belongs to — a two-valued narrowing of `EnvTarget`
 * (`preview` reuses the production port). Each target has exactly one port;
 * read through `portFor(project, target)` in `lib/deploy/ports.ts` (and
 * `effectivePortFor` to fold in a per-domain override).
 */
export type PortTarget = "production" | "development";

/**
 * A project's dev-mode configuration. Absent (`null`/`undefined`) ⇒ dev mode
 * was never enabled (back-compat). Offered only for source-bearing projects
 * (`github`/`git`/`upload`). State lives here, never in a `Deployment` row.
 */
export interface DevConfig {
  enabled: boolean;
  /** Push-only, like project.status — not reconciled against live docker. */
  status: DevStatus;
  /** "preset" → `image` is a DevImagePreset id; "custom" → `image` is raw. */
  imageKind: "preset" | "custom";
  /** Preset id (resolved to an official base) or a raw custom image string. */
  image: string;
  /** Dev command; default from the framework's `dev` command (e.g. "next dev"). */
  devCommand: string;
  /** The development PortTarget. Defaults to build.port. */
  port: number;
  /**
   * Preview route on by default → dev-<slug>.<ip>.sslip.io. A LABEL-only route,
   * never a Domain row; the URL is computed from slug+IP, not stored/managed.
   */
  previewEnabled: boolean;
  latestStartAt: string | null;
}

/**
 * A Linux account on the SSH gateway, scoped to exactly one project. The
 * password is stored REVERSIBLY (encrypted, not scrypt-hashed like
 * `User.passwordHash`) only because `chpasswd` needs the cleartext — and is
 * write-only from the dashboard (masked in the DTO, no reveal path). At least
 * one credential (key or password) is required; "neither" is rejected at both
 * the action and data layers.
 */
export interface DevSshUser {
  id: ID; // newId("ssh")
  /** The ONE project this user may reach. */
  projectId: ID;
  /** Gateway-global login, namespaced `<slug>-<name>` to keep it unique. */
  username: string;
  /** authorized_keys line(s); plaintext (public). Null when password-only. */
  publicKey: string | null;
  /**
   * encryptSecret(password). Reversible ONLY because chpasswd needs cleartext.
   * Write-only: masked in the DTO with no reveal path. Null when key-only.
   */
  passwordEnc: string | null;
  // NOTE: no targetUser — the gateway always execs as `devuser` (UID 1000).
  // A configurable exec target is a privilege-escalation footgun (ADR-0003).
  createdAt: string;
}

/** DTO sent to the client: the password is masked with NO reveal path. */
export interface DevSshUserDTO {
  id: ID;
  username: string;
  /** The public key, shown verbatim (it is public). Null when password-only. */
  publicKey: string | null;
  /** Whether a password is set. The password itself is never sent. */
  hasPassword: boolean;
  createdAt: string;
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
  /**
   * The code archive currently backing an "upload" source (else null). The file
   * lives on disk under DATA_DIR/uploads/<projectId>/; this is the pointer the
   * deploy pipeline extracts and builds. Re-uploading replaces it.
   */
  upload: UploadArchive | null;
  /** Editable docker-compose stack for template/compose deploys (else null). */
  compose: string | null;
  /**
   * For multi-service compose/template deploys: which service Traefik exposes
   * and on which container port. Null for single-image/built projects (the
   * build config's port is used instead). The first of `exposes`.
   */
  expose: { service: string; port: number } | null;
  /**
   * Every publicly-routed service in a compose/template stack, each on its own
   * hostname. Templates like garage-with-ui expose two (an API and a web UI).
   * `host` is the registered domain Traefik routes to that service; empty/absent
   * means "the project's primary domain". Null/empty for single-service deploys.
   */
  exposes?: { service: string; port: number; host?: string }[] | null;
  /**
   * Config files a template bind-mounts into its stack (e.g. an app's
   * configuration.yml). Written next to the stack at deploy time with the same
   * generated secrets the env uses. Null/empty for most projects.
   */
  mounts?: { filePath: string; content: string }[] | null;
  build: BuildConfig;
  /**
   * Dev-mode configuration. Absent ⇒ dev mode was never enabled (back-compat).
   * A sibling of the production stack with an independent lifecycle; never a
   * `Deployment`. Offered only for source-bearing sources.
   */
  dev?: DevConfig | null;
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
  /**
   * Where this deployment's image is built FROM. Absent ⇒ the project's own
   * `source` (git clone / upload archive / docker pull) — the normal path.
   * "dev-workspace" is the explicit exception (CONTEXT.md): build PRODUCTION
   * from the developer's live, edited tree at /data/dev/<slug> instead of
   * re-cloning the source. Persisted on the row because runDeployment re-reads
   * the deployment by id across the fire-and-forget boundary and must recover
   * the intent (a side map would not survive a process restart).
   */
  buildSource?: "dev-workspace";
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
  /**
   * "auto"  the zero-config sslip.io hostname Deplo generates for every
   * deployment (already routed, no DNS setup). "custom"  a domain the user
   * added and must point at this server. Defaults to "custom" when absent.
   */
  source?: "auto" | "custom";
  /**
   * Container port this hostname's Traefik router targets. Null/absent ⇒ route
   * to the project's default port (single-image `build.port`, or the compose
   * stack's exposed port) — the long-standing behaviour where every domain hits
   * the same service. When set, this host gets its own router on that port, so
   * one container can expose different services on different domains.
   */
  port?: number | null;
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

/**
 * A GitHub App connected to this Deplo instance, created through GitHub's App
 * Manifest flow (one click  no manual copy/paste of ids and keys, the way
 * Dokploy/Coolify do it). The private key and secrets are encrypted at rest and
 * never leave the server; the dashboard only ever sees the public fields.
 */
export interface GithubApp {
  id: ID;
  /** Numeric GitHub App id (used as the JWT issuer). */
  appId: number;
  /** URL slug, e.g. used to build the install URL github.com/apps/<slug>. */
  slug: string;
  name: string;
  clientId: string;
  /** encrypted at rest */
  clientSecretEnc: string;
  /** encrypted at rest  verifies inbound webhook signatures */
  webhookSecretEnc: string;
  /** encrypted at rest  PEM used to sign installation-token JWTs (RS256) */
  privateKeyEnc: string;
  htmlUrl: string;
  createdAt: string;
}

/**
 * An installation of a connected GitHub App on a user/org account. The
 * installation id is what mints short-lived access tokens to list and clone the
 * repositories the user granted access to.
 */
export interface GithubInstallation {
  id: ID;
  /** FK to the GithubApp this installation belongs to. */
  appId: ID;
  /** Numeric GitHub installation id. */
  installationId: number;
  /** Account the app was installed on (login + kind). */
  accountLogin: string;
  accountType: "User" | "Organization";
  avatarUrl: string;
  createdAt: string;
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
  githubApps: GithubApp[];
  githubInstallations: GithubInstallation[];
  /** Dev SSH users — the sole source of truth for the SSH gateway projection. */
  devSshUsers: DevSshUser[];
}
