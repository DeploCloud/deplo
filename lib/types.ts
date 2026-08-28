// Type-only (erased at runtime), so the framework catalog can keep importing
// BuildMethod from here without either module ever forming a runtime cycle.
import type { FrameworkId } from "./apps/framework-catalog";

export type ID = string;

export type Role = "owner" | "member" | "viewer";

/**
 * A single thing a member is allowed to do within a team - ONE action, never a
 * bundle. `view` is the always-on floor: every member of a team holds it, and it
 * is never offered as a toggle.
 */
export type Capability =
  | "view"
  // Apps
  | "create_apps"
  | "deploy_apps"
  | "rollback_apps"
  | "control_apps"
  | "configure_apps"
  | "delete_apps"
  | "move_apps"
  | "open_app_console"
  | "manage_previews"
  | "manage_crons"
  // App configuration
  | "manage_domains"
  | "manage_basic_auth"
  | "manage_env"
  | "reveal_secrets"
  | "read_app_files"
  | "write_app_files"
  // Folders & projects
  | "create_folders"
  | "organize_folders"
  | "delete_folders"
  | "create_projects"
  | "organize_projects"
  | "delete_projects"
  | "manage_environments"
  // Databases
  | "create_databases"
  | "configure_databases"
  | "control_databases"
  | "delete_databases"
  | "open_database_console"
  // Backups & storage
  | "manage_backups"
  | "restore_backups"
  | "delete_backups"
  | "manage_backup_destinations"
  // Integrations & API
  | "manage_registries"
  | "manage_git"
  | "manage_tokens"
  | "manage_mcp"
  | "manage_notifications"
  // Logs & monitoring
  | "view_logs"
  | "view_metrics"
  | "manage_monitoring"
  | "view_activity"
  // Team administration
  | "manage_members"
  | "manage_roles"
  | "manage_team"
  | "delete_team";

/**
 * Canonical order of every capability - the order the role editor lists them in
 * and the order every stored set is normalised to. Keep it in step with
 * `CAPABILITY_CATEGORIES` in `lib/capabilities.ts` (a test pins the two together).
 */
export const ALL_CAPABILITIES: Capability[] = [
  "view",
  "create_apps",
  "deploy_apps",
  "rollback_apps",
  "control_apps",
  "configure_apps",
  "delete_apps",
  "move_apps",
  "open_app_console",
  "manage_previews",
  "manage_crons",
  "manage_domains",
  "manage_basic_auth",
  "manage_env",
  "reveal_secrets",
  "read_app_files",
  "write_app_files",
  "create_folders",
  "organize_folders",
  "delete_folders",
  "create_projects",
  "organize_projects",
  "delete_projects",
  "manage_environments",
  "create_databases",
  "configure_databases",
  "control_databases",
  "delete_databases",
  "open_database_console",
  "manage_backups",
  "restore_backups",
  "delete_backups",
  "manage_backup_destinations",
  "manage_registries",
  "manage_git",
  "manage_tokens",
  "manage_mcp",
  "manage_notifications",
  "view_logs",
  "view_metrics",
  "manage_monitoring",
  "view_activity",
  "manage_members",
  "manage_roles",
  "manage_team",
  "delete_team",
];

export interface User {
  id: ID;
  email: string;
  /**
   * Unique, instance-wide handle - the public identity. Shown (with no email)
   * in the member picker and the global users list, and used to add an existing
   * user to a team. Lowercased, `[a-z0-9_-]`, unique across the instance.
   */
  username: string;
  name: string;
  /**
   * Legacy instance-wide role. Retained for back-compat with documents written
   * before per-team memberships; the source of truth for what a user can do is
   * now their {@link Membership} in the active team.
   */
  role: Role;
  /**
   * Global-scoped admin. The first account (setup) is an instance admin. Distinct
   * from per-team capabilities (which only ever scope to one team).
   */
  isInstanceAdmin?: boolean;
  /**
   * Globally suspended: cannot sign in and is treated as having no access until
   * re-activated. Does not delete the account or its memberships.
   */
  suspended?: boolean;
  /**
   * Instance-wide grant: may publish container ports declared in a compose stack -
   * a service's `ports:` (bound to the host) or `expose:`.
   */
  canExposePorts?: boolean;
  /**
   * Instance-wide grant: may bind-mount a real HOST filesystem path into a
   * container (NOT docker-managed named/anonymous volumes).
   */
  canMountHostVolumes?: boolean;
  avatarColor: string;
  createdAt: string;
}

/** DTO safe to send to the client. */
export interface PublicUser {
  id: ID;
  email: string;
  username: string;
  name: string;
  role: Role;
  isInstanceAdmin: boolean;
  avatarColor: string;
  /**
   * Where this person's picture comes from, already resolved: their uploaded
   * image, else their Gravatar (when the instance allows it), else null for the
   * {@link avatarColor} monogram. Always COMPUTED server-side, never a raw column.
   */
  avatarUrl: string | null;
  /**
   * True once the account has a verified TOTP factor. Safe to expose: it says
   * whether a second factor exists, never anything about the factor itself.
   * Drives the reminder modal and the "2FA required" gate's messaging.
   */
  twoFactorEnabled: boolean;
}

/**
 * A user's membership of a team - the join row that makes the app multi-tenant.
 */
export interface Membership {
  id: ID;
  userId: ID;
  teamId: ID;
  role: Role;
  capabilities: Capability[];
  createdAt: string;
}

export type InviteStatus = "pending" | "accepted" | "revoked";

/**
 * An invitation to join a team. The raw token is embedded in the invite link
 * (and email) and only its sha256 hash is stored, exactly like an API token.
 * Accepting an invite creates the User (if new) and the {@link Membership}.
 */
export interface Invite {
  id: ID;
  teamId: ID;
  email: string;
  role: Role;
  capabilities: Capability[];
  /** sha256 of the raw invite token; the raw token is never stored. */
  tokenHash: string;
  status: InviteStatus;
  /** Name of the member who created the invite (for display). */
  invitedBy: string;
  expiresAt: string;
  createdAt: string;
  acceptedAt: string | null;
}

export type RegistrationLinkStatus = "pending" | "used" | "revoked";

/**
 * A single-use link that lets a new person self-register a brand-new account AND
 * their own team (like the first-run setup, not a team invite).
 */
export interface RegistrationLink {
  id: ID;
  /** sha256 of the raw token; the raw token lives only in the link. */
  tokenHash: string;
  status: RegistrationLinkStatus;
  /** Username of the member who minted it (for display). */
  createdBy: string;
  /** Set once used: the username that registered through it. */
  usedByUsername: string | null;
  /** Automatic expiry, 24h after minting; enforced on every read and at consume. */
  expiresAt: string;
  createdAt: string;
  usedAt: string | null;
}

export interface Team {
  id: ID;
  name: string;
  slug: string;
  plan: "pro" | "enterprise";
  /**
   * The team's ABSOLUTE owner - the user who originally created the team, the
   * holder of the "crown" (👑).
   */
  founderUserId?: ID | null;
  /**
   * Team-wide 2FA policy. When true, a member without a verified second factor
   * resolves no capabilities in this team, over the UI and the bearer API alike.
   * Never auto-enabled; enabling is refused unless the actor has 2FA themselves.
   */
  requireTwoFactor?: boolean;
  /**
   * Team-wide display order of apps in the Overview grid (array of project ids,
   * first = top-left). Absent ⇒ no manual order yet, fall back to
   * newest-updated-first.
   */
  appOrder?: ID[];
  /**
   * Team-wide display order of FOLDERS in the Overview grid (folder ids, first =
   * leftmost). Folders render before ungrouped apps. Absent ⇒ fall back to
   * newest-first. Stale/missing ids are tolerated exactly like {@link appOrder}.
   */
  folderOrder?: ID[];
  /**
   * The team's picture, already resolved: its uploaded image, or null for the
   * two-letter monogram. Unlike a person's there is no Gravatar step - a team has
   * no email, so this is the stored value, validated on the way out.
   */
  avatarUrl: string | null;
  createdAt: string;
}

/**
 * Who a team IS, with none of its settings - what the shell needs to name the team
 * you are working in, on every page.
 */
export type TeamIdentity = Pick<Team, "id" | "name" | "slug" | "avatarUrl">;

/** A team as shown in the switcher: the user's role in it + its size. */
export interface TeamSummary extends Team {
  role: string;
  memberCount: number;
  /** Whether this person may change anything in that team's settings. */
  canManage: boolean;
}

/**
 * A team-wide grouping of apps shown on the Overview. Creating a folder requires
 * the `deploy` capability - the same gate as creating a project.
 */
export interface Folder {
  id: ID;
  teamId: ID;
  name: string;
  /**
   * Parent folder id for nesting, or null/absent when this folder sits at the top
   * level.
   */
  parentId?: ID | null;
  /**
   * Optional accent colour for the folder tile on the Overview, stored as a
   * normalised `#rrggbb` hex string.
   */
  color?: string | null;
  /**
   * The folder's OWNER - the user who created it. Null/absent only for legacy
   * folders whose owner could not be backfilled, or after the owner's account is
   * deleted (the FK is `ON DELETE SET NULL`).
   */
  ownerUserId?: ID | null;
  /**
   * The {@link Project} CONTAINER this folder lives in, or null/absent when it
   * sits at the team top level (ADR-0008, additive). A `projectId` with no
   * matching project is tolerated and treated as top-level.
   */
  projectId?: ID | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * A **Project** - the top-level, team-scoped CONTAINER introduced in ADR-0008.
 * Folders and Apps live INSIDE a Project via their `projectId`; a Project never
 * nests in another Project (no `parentId`).
 */
export interface Project {
  id: ID;
  teamId: ID;
  name: string;
  /** Team-unique, URL-safe key (kept for the legacy `/projects/<slug>` redirect). */
  slug: string;
  /** Optional accent colour (`#rrggbb`), same semantics as {@link Folder.color}. */
  color?: string | null;
  /** The owner (creator); same ownership model as {@link Folder.ownerUserId}. */
  ownerUserId?: ID | null;
  /** The migration still creating this project. See {@link App.migrationRunId}. */
  migrationRunId?: ID | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * The well-known ROLE of an {@link Environment} - the discriminant that keeps
 * legacy `EnvTarget` resolution and team/instance/shared-env targeting working
 * once environments become customizable.
 */
export type EnvironmentKind =
  "development" | "preview" | "production" | "custom";

/**
 * An **Environment** (ADR-0008 Phase 3) - a per-{@link Project}, first-class
 * ISOLATED deploy target.
 */
export interface Environment {
  id: ID;
  /** The owning {@link Project} container. */
  projectId: ID;
  name: string;
  /** Stable per-project key (drives the pipeline deploy-key + `?env=` routing). */
  slug: string;
  /** Well-known role; the migration/compat bridge for global-env targeting. */
  kind: EnvironmentKind;
  /** This environment's own git branch (empty ⇒ the app's default branch). */
  gitBranch: string;
  /** Exactly one environment per project is the default (seeded: Production). */
  isDefault: boolean;
  position: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * A server's health, as last OBSERVED by a live agent `Hello` probe, not a
 * lifecycle the control plane drives.
 */
export type ServerStatus =
  "online" | "warning" | "error" | "offline" | "provisioning";

/**
 * The agent trust + reachability material for a server (PLAN Part B).
 */
export interface ServerAgent {
  /** The TCP port the agent's gRPC listener is on (default 9443). */
  port: number;
  /**
   * sha256(DER) of the agent's signed server cert, lowercase hex - the pinning
   * identity (P3/P6). The control plane trusts an agent iff the cert it presents
   * on dial matches this. Cleared on removal to revoke trust.
   */
  certFingerprint: string;
  /** The agent's signed server certificate, PEM (public; for diagnostics/renewal). */
  certPem: string;
  /** The agent binary version reported at the last successful Hello (diagnostics). */
  version: string;
}

/**
 * The one-time bootstrap secret for a provisioning server (PLAN P2). Mirrors the
 * registration-link pattern ([[RegistrationLink]]) - only the token's sha256 is
 * stored, never the raw token, and both carry a short automatic expiry.
 */
export interface ServerBootstrap {
  /** sha256 of the raw one-time token; the raw token lives only in the install command. */
  tokenHash: string;
  /** When the token expires (ISO). Past it, call-home is refused. */
  expiresAt: string;
  /** Set once the agent has called home and been provisioned. */
  usedAt: string | null;
}

export interface Server {
  id: ID;
  name: string;
  /** The server's reachable IP/host (the host running Deplo is dialed the same way). */
  host: string;
  /**
   * Discriminant retained for forward-compat; every server is now reached only
   * through its agent over mTLS (the host running Deplo included), so there is no
   * longer a special "localhost" kind.
   */
  type: "remote";
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
  /**
   * Team access scope.
   */
  allTeams: boolean;
  /**
   * A server bought purely to HOLD BACKUPS: the agent is installed, Docker is not,
   * and nothing is ever deployed here.
   */
  storageOnly: boolean;
  /**
   * A server bought purely to COMPILE: Docker is installed, Traefik is not, and no
   * app of any team runs here.
   */
  buildOnly: boolean;
  /**
   * A server registered ONLY to import from another platform - the host the
   * migration reads its volumes from, nothing else.
   */
  importOnly: boolean;
  /**
   * Deplo is still trying to take its agent off this migration source. Set from
   * the moment the migration finishes until the host lets go - a few minutes at
   * most, and nothing is asked of anyone while it is true.
   */
  uninstallPending: boolean;
  /**
   * Why Deplo could not take its agent off this migration source, after it stopped
   * trying.
   */
  uninstallError: string;
  /**
   * This host's CPU architecture ("amd64" | "arm64"), observed from each Hello.
   * "" when the agent is too old to report it, which keeps the server out of the
   * build-server picker rather than risking an image the target cannot execute.
   */
  hostArch: string;
  /**
   * How many deployments this server runs concurrently - the per-server slot count
   * the deploy queue enforces. 1 (the default a server is born with) = strict
   * serialization: one deploy at a time on this host, deploys on other servers
   * still run in parallel.
   */
  deployConcurrency: number;
  /**
   * The Traefik web panel: the host's own Traefik dashboard, published here.
   */
  traefikDashboard?: { domain: string; username: string };
  createdAt: string;
  /**
   * Agent trust material - present once a server is provisioned (Part B). Absent
   * only while a server is still in `provisioning` (before its agent has called
   * home). Applies to every server, the host running Deplo included.
   */
  agent?: ServerAgent;
  /**
   * The pending call-home bootstrap secret - present only while a server is
   * `provisioning`, cleared once its agent has been provisioned (Part B, P2).
   */
  bootstrap?: ServerBootstrap;
  /**
   * Last time the agent answered (ISO) - fed by the heartbeat (P5). A CACHE
   * behind the live-read health check, never the source of truth.
   */
  lastSeenAt?: string;
  /**
   * When [[Server.status]] was last OBSERVED (ISO) - i.e. when a probe classified
   * and recorded a result, not when the row was last written.
   */
  statusCheckedAt?: string;
  /**
   * The operator-facing reason behind a non-`online` status ("Docker daemon
   * unreachable - deploys to this server will fail"), from the closed set in
   * `classifyServerHealth`. Absent when `online` or never probed.
   */
  statusMessage?: string;
}

export type AppStatus =
  | "active"
  | "building"
  | "error"
  | "queued"
  | "idle"
  // Transient: the user pressed Stop and the container is being brought down.
  // Persisted (so it survives reload and every client sees it) until the stop
  // completes and the project settles to "idle".
  | "stopping"
  // Transient: a backup is being put back in place.
  | "restoring";

/**
 * Where a project's code/image comes from.
 */
export type DeploySource =
  "github" | "git" | "docker-image" | "upload" | "compose";

/**
 * How old a migration run's heartbeat may be before nobody is driving it.
 */
export const MIGRATION_HEARTBEAT_STALE_MS = 90_000;

/**
 * The internal `DeploySource` strings are lowercase and hyphenated
 * ("docker-image"), but the GraphQL `DeploySource` enum exposes uppercase,
 * underscored value *names* (GITHUB, DOCKER_IMAGE …) - GraphQL enum names can't
 * contain hyphens.
 */
export function deploySourceEnumName(source: DeploySource): string {
  return source.replace(/-/g, "_").toUpperCase();
}

/**
 * A code archive uploaded from the dashboard, backing an "upload" source. The
 * tarball/zip is written to DATA_DIR/uploads/<appId>/<id><ext> and built
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

/**
 * Which git event drives an automatic deployment when auto-deploy is on: - push a
 * push to the repo's tracked `branch` (the historical default) - tag any new tag
 * pushed to the repo Absent/`undefined` is treated as "push".
 */
export type GitTriggerType = "push" | "tag";

export interface GitRepo {
  provider: "github" | GitProviderId;
  url: string;
  repo: string; // owner/name
  branch: string;
  /**
   * For private GitHub repos cloned through a connected GitHub App: the id of
   * the installation whose short-lived token authenticates the clone. Absent
   * for public repos or plain Git URLs.
   */
  installationId?: string | null;
  /**
   * For every OTHER host: the {@link GitConnection} whose stored token
   * authenticates the clone and registers the push webhook.
   */
  connectionId?: string | null;
  /**
   * Which git event auto-deploys this app (see {@link GitTriggerType}).
   * Absent ⇒ "push". Consumed by the GitHub webhook to gate a delivery.
   */
  triggerType?: GitTriggerType;
  /**
   * Optional path globs (one per entry).
   */
  watchPaths?: string[];
  /**
   * Clone the repository's git submodules (recurse-submodules) at build time.
   * Absent ⇒ false.
   */
  submodules?: boolean;
}

/**
 * How Deplo turns a repository into a runnable image.
 */
export type BuildMethod = "dockerfile" | "railpack" | "nixpacks" | "static";

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
  /** nixpacks: after the build, serve just this directory as a static site via
   *  nginx (informational elsewhere). */
  nixpacksPublishDirectory?: string;
  /** static: serve as a single-page app (SPA history-API fallback to index.html). */
  staticSinglePageApp?: boolean;
}

export interface BuildConfig {
  /** Which builder turns the repo into an image. Defaults to "nixpacks". */
  buildMethod: BuildMethod;
  /** Settings scoped to the active build method (see BuildMethodSettings). */
  methodSettings: BuildMethodSettings;
  /**
   * The following command/runtime fields are retained on the stored model for
   * the deploy builders and legacy rows, but are no longer surfaced in the build
   * settings UI (the builders auto-detect them). New apps default them empty.
   */
  rootDirectory: string;
  /**
   * Include files OUTSIDE the root directory in the build context.
   */
  includeFilesOutsideRoot: boolean;
  /**
   * Skip an auto-deploy when an inbound push changed nothing inside the root
   * directory. Default false. Gates git push-triggered deploys only - a manual
   * redeploy always runs regardless.
   */
  skipUnchangedDeployments: boolean;
  /**
   * Reuse the owning server's Docker layer cache (and the builder's own cache
   * mounts) between this app's builds.
   */
  buildCache: boolean;
  /**
   * Armed by "Clear build cache", consumed by the next build (which then runs
   * cache-less exactly once).
   */
  buildCacheClearPending: boolean;
  installCommand: string;
  buildCommand: string;
  outputDirectory: string;
  startCommand: string;
  /**
   * Pinned runtime version, interpreted per language by the builder; empty means
   * "use the builder's default".
   */
  runtimeVersion: string;
  /** Container port Traefik routes to. The one build field still shown in the UI. */
  port: number;
}

/**
 * How mounts appearing UNDERNEATH a bind mount cross between the server and the
 * container.
 */
export const MOUNT_PROPAGATIONS = ["rslave", "rshared"] as const;
export type MountPropagation = (typeof MOUNT_PROPAGATIONS)[number];

/**
 * A persistent volume mounted into an app's container. No grant needed - it can't
 * escape the project. - "host": a bind mount of a real HOST filesystem path
 * (`hostPath`).
 */
export interface VolumeMount {
  /**
   * Stable id (server: newId("vol"); client draft rows: vol_<shortId>). Lets the
   * UI key rows and lets a rename of `name` not look like delete+create.
   */
  id: ID;
  /**
   * Kind of mount. Absent ⇒ "named" (docker-managed) so documents written before
   * host bind mounts existed keep rendering identically.
   */
  type?: "named" | "app" | "host";
  /**
   * Human label, lowercase-kebab, UNIQUE PER PROJECT. Namespaced on the host.
   * Named volumes only (ignored for "app"/"host" mounts).
   */
  name: string;
  /**
   * Path RELATIVE to the project's isolated files dir, e.g. "config.toml" or
   * "uploads". App mounts only (type === "app"); never contains "..".
   * Absent/ignored for named and host mounts.
   */
  projectPath?: string;
  /**
   * Absolute HOST path to bind-mount, e.g. "/srv/data". Host mounts only
   * (type === "host"); absent/ignored for named and project mounts.
   */
  hostPath?: string;
  /**
   * COMPOSE-STACK apps only: the compose service to mount into. Empty/absent ⇒ the
   * stack's default service (the one a domain would route to - a published port,
   * else the first).
   */
  service?: string | null;
  /**
   * Absolute in-container mount path, e.g. "/data". UNIQUE PER PROJECT, or, for
   * a compose stack, unique per (service, path), so two services can each mount
   * their own volume at `/data`.
   */
  mountPath: string;
  /** Mount read-only (`:ro`). Defaults to false (read-write). */
  readOnly: boolean;
  /**
   * HOST binds only: whether the mount follows submounts that appear later.
   */
  propagation?: MountPropagation;
}

/**
 * Per-app resource limits - caps applied to the app's container(s) at deploy time
 * so a runaway app can't starve its neighbours on a shared host.
 */
export interface ResourceLimits {
  /** Hard RAM ceiling, MiB → `mem_limit`. The container is OOM-killed above it. */
  memoryMb: number | null;
  /** Soft RAM reservation, MiB → `mem_reservation` (a scheduling hint, not a cap). */
  memoryReservationMb: number | null;
  /** Memory + swap ceiling, MiB → `memswap_limit`. Must be ≥ `memoryMb`. */
  swapMb: number | null;
  /** Hard CPU ceiling in milli-CPUs (1000 = one core) → `cpus`. */
  cpuMilli: number | null;
  /** Relative CPU weight under contention, 2-262144 → `cpu_shares`. */
  cpuShares: number | null;
  /** Pin to specific host cores, e.g. "0,2-3" → `cpuset`. */
  cpuset: string | null;
  /** Max processes/threads (fork-bomb guard) → `pids_limit`. */
  pidsLimit: number | null;
  /** `/dev/shm` size, MiB → `shm_size`. */
  shmSizeMb: number | null;
  /**
   * Writable-layer disk quota, GiB → `storage_opt.size`.
   */
  storageGb: number | null;
  /** Max open file descriptors → `ulimits.nofile` (soft = hard). */
  nofile: number | null;
  /** Max processes for the container user → `ulimits.nproc` (soft = hard). */
  nproc: number | null;
  /** OOM-killer priority, -1000..1000 → `oom_score_adj` (higher = killed first). */
  oomScoreAdj: number | null;
}

/**
 * A per-app health check → the compose `healthcheck:` block. Docker runs it inside
 * the container, the agent reports what it says, and the status dot follows.
 * See https://deplo.build/docs/guides/observability/monitoring
 */
export interface HealthCheck {
  /** `http` asks the app over localhost; `command` runs whatever you give it. */
  type: "http" | "command";
  /** http only. The path to request, e.g. `/healthz`. */
  path: string | null;
  /** http only. The port INSIDE the container; the app's own port when null. */
  port: number | null;
  /** command only. Run through a shell, so a pipe or a `||` works. */
  command: string | null;
  /** Seconds between checks. */
  intervalS: number;
  /** Seconds one check may take before it counts as a failure. */
  timeoutS: number;
  /** Consecutive failures before the container is called unhealthy. */
  retries: number;
  /** Seconds of grace while the app starts, during which a failure does not count. */
  startPeriodS: number;
}

export interface App {
  id: ID;
  name: string;
  slug: string;
  teamId: ID;
  /**
   * The folder this project lives in on the Overview, or null/absent when it sits
   * at the top level (ungrouped).
   */
  folderId?: ID | null;
  /**
   * The {@link Project} this app belongs to, or null/absent when it sits at the
   * team top level (ADR-0008, additive).
   */
  projectId?: ID | null;
  /**
   * The {@link Environment} (of `projectId`'s Project) this app LIVES in -
   * ADR-0009's membership axis: each environment of a project holds its own apps,
   * like a sub-folder picked from the project's environment dropdown. null/absent
   * outside a project.
   */
  environmentId?: ID | null;
  serverId: ID;
  /**
   * Set on a server MOVE when the OLD server still holds this app's data: the
   * source host the next successful deploy on `serverId` must copy the data
   * volumes + files dir FROM (host-to-host).
   */
  migrateFromServerId?: ID | null;
  /**
   * Why this app's data did not arrive, when a migration tried to copy it and
   * could not. Empty string in the common case - every app that was never
   * migrated, and every migration whose copy worked.
   */
  dataCopyError: string;
  /**
   * The migration still creating this app, or null - which is every app that is
   * not arriving right now.
   */
  migrationRunId: ID | null;
  /**
   * Which server BUILDS this app's image, when that is not `serverId`. null is
   * "Automatic": a build-only server if the fleet has one this team can reach and
   * its arch matches, otherwise build where the app runs.
   */
  buildServerId?: ID | null;
  /**
   * Build on this app's own server when the build server is unreachable, saying so
   * in the deploy log. true by default; false for whoever picked a small deploy
   * server on purpose and would rather fail than have a build land on it.
   */
  buildFallbackLocal: boolean;
  /**
   * Display logo for the project (a URL or local /templates/<x> path). Defaulted
   * from the template's logo when deployed from one, editable from settings.
   * Null ⇒ fall back to a generic icon. NOT the Docker image (`dockerImage`).
   */
  logo: string | null;
  /**
   * The JavaScript framework Deplo recognised in this app's own source - a {@link
   * FrameworkId} from `lib/apps/framework-catalog.ts` ("nextjs", "astro", …), or
   * null when none was found or the build method isn't one of the auto-detecting
   * builders (Nixpacks / Railpack), the only ones this applies to.
   */
  framework: FrameworkId | null;
  /**
   * The framework the user picked because detection got it wrong, or null (the
   * default) to trust detection.
   */
  frameworkOverride: FrameworkId | null;
  /** How this project is deployed (git, docker image, dockerfile, upload). */
  source: DeploySource;
  repo: GitRepo | null;
  /** Image reference when source is "docker-image" (e.g. ghcr.io/org/app:tag). */
  dockerImage: string | null;
  /**
   * The code archive currently backing an "upload" source (else null). The file
   * lives on disk under DATA_DIR/uploads/<appId>/; this is the pointer the
   * deploy pipeline extracts and builds. Re-uploading replaces it.
   */
  upload: UploadArchive | null;
  /** Editable docker-compose stack for template/compose deploys (else null). */
  compose: string | null;
  /**
   * Config files a template bind-mounts into its stack (e.g. an app's
   * configuration.yml). Written next to the stack at deploy time with the same
   * generated secrets the env uses. Null/empty for most apps.
   */
  mounts?: { filePath: string; content: string }[] | null;
  /**
   * User-managed persistent volumes for the SINGLE-CONTAINER deploy path
   * (renderCompose) - docker-managed named volumes and (for privileged users) host
   * bind mounts. null/absent for compose-stack apps and apps that never added one,
   * so renderCompose emits no `volumes:` keys and the stack stays byte-identical
   * (no reroute churn).
   */
  volumes?: VolumeMount[] | null;
  build: BuildConfig;
  productionUrl: string | null;
  status: AppStatus;
  autoDeploy: boolean;
  /**
   * Pull request previews are ON for this app.
   */
  previewEnabled: boolean;
  /**
   * Cron jobs are ON for this app - same reason `previewEnabled` rides the App:
   * the sidebar decides whether to offer the Cron jobs page from it, and the
   * layout already has the row in hand.
   */
  cronEnabled: boolean;
  /**
   * The container console is ON for this app - same reason it rides the App as
   * `cronEnabled`: the sidebar and the console page both decide from it.
   */
  consoleEnabled: boolean;
  /**
   * Whether this app's deploy hook - the URL that triggers a production deploy
   * from outside the dashboard - answers at all.
   */
  deployHookEnabled: boolean;
  /**
   * Extra flags this app appends to the `docker compose up` that brings it up, as
   * the operator typed them (`"--pull always --scale web=3"`), or null for the
   * untouched command, which is every app that never opened the setting.
   */
  composeUpArgs: string | null;
  /**
   * How many previous deployments this app can be rolled back to (default 3).
   */
  rollbackKeep: number;
  /**
   * Per-app resource caps applied at deploy time, or `null` when the app has no
   * limits set (the default). See {@link ResourceLimits}.
   */
  resources: ResourceLimits | null;
  /** Null when the app has no health check - which is the default. */
  healthCheck: HealthCheck | null;
  latestDeploymentId: ID | null;
  /**
   * When someone confirmed this app's deletion, or null (every app that is not on
   * its way out). Treat it as gone: every gate refuses a stamped app, its pages
   * 404, and no user-facing list returns it (`listApps` filters on this).
   */
  deletingAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * How many previous deployments a new app can be rolled back to.
 */
export const DEFAULT_ROLLBACK_KEEP = 3;

/** The ceiling on {@link App.rollbackKeep}. Retention is disk: past this, an app
 *  is hoarding gigabytes of images nobody will ever roll back to. `0` is the
 *  floor and means "keep nothing to go back to". */
export const MAX_ROLLBACK_KEEP = 20;

/**
 * How far back the log viewer's time range reaches out of the box, in days, and
 * the ceiling an instance admin may raise it to.
 */
export const DEFAULT_LOG_RANGE_DAYS = 7;
export const MAX_LOG_RANGE_DAYS = 90;
export const MIN_LOG_RANGE_DAYS = 1;

export type DeploymentStatus =
  "queued" | "building" | "ready" | "error" | "canceled";

export type DeploymentEnvironment = "production" | "preview";

export interface Deployment {
  id: ID;
  appId: ID;
  status: DeploymentStatus;
  environment: DeploymentEnvironment;
  /**
   * The host-side KEY this deploy owns: the container `deplo-<key>`, the stack
   * file `<key>.yml`, the files dir `files/<key>`, the named volumes
   * `deplo-<key>-<name>` and every agent RPC.
   */
  deployKey: string;
  /** The pull request preview this deploy belongs to, or null for production. */
  previewId: ID | null;
  /** Denormalized pull request number, so the deployments list can still say
   *  "PR #42" after the preview row is reaped. Null for production. */
  prNumber: number | null;
  /**
   * The server this deploy runs on. Denormalized so the queue can drain per-server
   * without an apps join, and load-bearing beyond that, because a pull request
   * preview may be pinned to a different machine than production.
   */
  serverId: ID | null;
  /**
   * The server this deploy BUILT on, when that was not `serverId`. null is the
   * ordinary case, "built where it runs", and is also what every row that predates
   * build servers holds.
   */
  buildServerId: ID | null;
  commitSha: string;
  commitMessage: string;
  commitAuthor: string;
  branch: string;
  url: string;
  createdAt: string;
  /** When the build was claimed off the queue and actually started running -
   *  the origin `buildDurationMs` is measured from, and what the UI ticks the
   *  live "Build time" from. Null while queued (nothing has started yet). */
  startedAt: string | null;
  readyAt: string | null;
  buildDurationMs: number | null;
  /**
   * Replace the running containers even if the rendered stack is unchanged
   * (`compose up --force-recreate`).
   */
  forceRecreate: boolean;
  /**
   * The image tag this deploy rendered into its stack and the agent ran.
   */
  imageRef: string | null;
  /** Set when this deploy is a ROLLBACK: the deployment whose image it re-ran.
   *  Null ⇒ this deploy built its own image (which is also what decides whether it
   *  occupies a retention slot - a rollback reuses an image, it does not add one). */
  rollbackOf: ID | null;
  creator: string;
  /**
   * The account behind {@link creator}, when there is one. NULL for a webhook push
   * (whose creator is a GitHub login, not a deplo account) and for every row
   * written before it existed - both of which render the bare string.
   */
  creatorUserId: ID | null;
  /** That person, resolved for display. A DECORATION the list batch-resolves. */
  creatorUser: VarAuthor | null;
  /** The git host {@link creator} is a login on, set only by a webhook push
   *  ("github", "gitlab", "bitbucket", "gitea"). Null ⇒ somebody with an account
   *  here, drawn with their own avatar. */
  creatorProvider: string | null;
}

export type LogLevel =
  "info" | "warn" | "error" | "debug" | "command" | "success";

export interface LogLine {
  ts: string;
  level: LogLevel;
  text: string;
}

export type EnvTarget = "production" | "preview";

/** Canonical ordered list of every env target. (`development` died with dev
 * mode - migration 0041 stripped its junction rows.) */
export const ALL_ENV_TARGETS: EnvTarget[] = ["production", "preview"];

/**
 * Keep only valid targets, deduped and in canonical order; fall back to every
 * target if none survive.
 */
export function sanitizeTargets(targets: EnvTarget[]): EnvTarget[] {
  const kept = ALL_ENV_TARGETS.filter((t) => targets.includes(t));
  return kept.length ? kept : [...ALL_ENV_TARGETS];
}

/**
 * The refusal every env layer raises when a write would touch a SECRET row.
 * Immutability is what closes it: create it, delete it, never edit it. Promotion
 * `plain` -> `secret` stays open, because hardening is never the thing you gate.
 */
export const secretImmutable = (key: string) =>
  `${key} is a secret and cannot be edited. Delete it and add it again.`;

/**
 * Who created or last modified a variable. Identity fields only: never an email,
 * never a hash.
 */
export interface VarAuthor {
  id: ID;
  name: string;
  username: string;
  avatarColor: string;
  /** Resolved picture: uploaded image, else Gravatar, else null. See
   *  {@link PublicUser.avatarUrl} - the address itself never reaches here. */
  avatarUrl: string | null;
}

export interface EnvVar {
  id: ID;
  appId: ID;
  key: string;
  /** encrypted at rest */
  valueEnc: string;
  targets: EnvTarget[];
  type: "plain" | "secret";
  createdByUserId: ID | null;
  updatedByUserId: ID | null;
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
  createdBy: VarAuthor | null;
  updatedBy: VarAuthor | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * A custom domain's DNS verification state. - valid an A record points straight at
 * this project's server. - cloudflare proxied through Cloudflare's orange-cloud:
 * the A records are Cloudflare's anycast IPs, which mask the origin.
 */
export type DomainStatus =
  "valid" | "cloudflare" | "pending" | "misconfigured" | "error";

/**
 * The Traefik entrypoint a domain's router binds to.
 */
export type DomainEntrypoint = "websecure" | "web";

/**
 * How a domain's TLS certificate is issued - the user's *choice*, distinct from
 * `ssl` (whether a cert is currently active, derived from DNS verification): -
 * letsencrypt the HTTP-01 ACME resolver baked into the proxy (resolved via
 * `certResolver()` / `DEPLO_CERT_RESOLVER`). - cloudflare Cloudflare fronts the
 * domain: it terminates TLS at its edge and presents the public certificate, so
 * the origin is served over HTTPS (`websecure`) with a DNS-01 resolver named
 * `cloudflare` when the proxy defines one.
 */
export type CertProvider = "letsencrypt" | "cloudflare" | "none" | "custom";

export interface Domain {
  id: ID;
  appId: ID;
  name: string;
  status: DomainStatus;
  primary: boolean;
  /**
   * The hostname this domain answers a permanent redirect (301) to, or null when
   * it serves the app.
   */
  redirectTo: string | null;
  ssl: boolean;
  /**
   * "auto" the zero-config nip.io hostname Deplo generates once per project
   * (already routed, no DNS setup). "custom" a domain the user added and must
   * point at this server.
   */
  source?: "auto" | "custom" | "redirect";
  /**
   * Container port this hostname's Traefik router targets.
   */
  port?: number | null;
  /**
   * Traefik entrypoint this host's router binds to. Absent ⇒ `websecure` (the
   * long-standing default). `web` serves plain HTTP on :80.
   */
  entrypoint?: DomainEntrypoint;
  /**
   * How TLS is issued for this host (see {@link CertProvider}). Absent ⇒
   * `letsencrypt`. `none` means no certificate - the router serves plain HTTP
   * and is forced onto the `web` entrypoint regardless of `entrypoint`.
   */
  certProvider?: CertProvider;
  /**
   * The hostname this domain REPLACED on the platform it was imported from, or
   * absent when it is the address the app always had.
   */
  importedFrom?: string | null;
  /**
   * Traefik middlewares applied to this host's router, in order, emitted as
   * `traefik.http.routers.<key>.middlewares=<m1>,<m2>,…`.
   */
  middlewares?: string[];
  /**
   * Path prefix this host's router matches, e.g. `/api`. Stored normalised: a
   * single leading slash, no trailing slash, never a scheme/host, never a backtick
   * (it is interpolated into a Traefik backtick literal).
   */
  pathPrefix?: string;
  /**
   * Strip {@link pathPrefix} from the request path before forwarding to the app,
   * via a generated Traefik `stripprefix` middleware prepended to {@link
   * middlewares} (so user middlewares see the already-stripped path the app sees).
   */
  stripPrefix?: boolean;
  /**
   * COMPOSE/template stacks only: which compose service this host's router
   * targets.
   */
  service?: string;
  /**
   * The user declaring that a proxy answers for this hostname, so its A records
   * name the proxy and the DNS check can never settle `valid`. Routed anyway -
   * the manual twin of the `cloudflare` status.
   */
  proxied?: boolean;
  createdAt: string;
}

/**
 * An HTTP Basic Auth credential that protects EVERY domain of a project.
 */
export interface BasicAuthUser {
  id: ID;
  appId: ID;
  username: string;
  /** AES-GCM-encrypted password. Reversible (re-hashed to htpasswd at render);
   * never in a DTO, read back only through the gated reveal. */
  passwordEnc: string;
  /** Carried over from another platform verbatim, so it never went through the
   * password policy or the breach check - see `addBasicAuthUser`. */
  imported?: boolean;
  /** Who added the credential / who last rotated its password. Null for rows
   * written before migration 0045, or once that user is deleted. Identity
   * metadata, never a value - see {@link VarAuthor}. */
  createdByUserId: ID | null;
  updatedByUserId: ID | null;
  createdAt: string;
  updatedAt: string;
}

export type DatabaseType =
  "postgres" | "mysql" | "mariadb" | "mongodb" | "redis" | "clickhouse";

export type DatabaseStatus = "running" | "stopped" | "provisioning" | "error";

export interface Database {
  id: ID;
  /** Owning team. Legacy rows are backfilled to the first team on hydrate. */
  teamId: ID;
  /**
   * DISPLAY name, editable in Settings → General.
   */
  name: string;
  /**
   * Uploaded display logo - a base64 image data-URI, or null to fall back to the
   * engine's real brand mark (`DB_LOGOS`). Same contract as an App's logo:
   * cosmetic only, never read by a deploy, validated by `isValidLogoValue`.
   */
  logo: string | null;
  type: DatabaseType;
  version: string;
  /**
   * The engine login the connection string authenticates as, and the user the
   * backup dump execs as (except mysql/mariadb, which always dump as `root` - see
   * {@link file://./data/backups.ts} `dumpUserFor`).
   */
  username: string;
  /**
   * The logical database created on first init (`POSTGRES_DB` / `MYSQL_DATABASE` /
   * `CLICKHOUSE_DB` / the mongo default DB).
   */
  dbName: string;
  status: DatabaseStatus;
  /**
   * Why this database's data did not arrive, when a migration tried to copy it and
   * could not.
   */
  dataCopyError: string;
  /** The migration still creating this database. See {@link App.migrationRunId}. */
  migrationRunId: ID | null;
  serverId: ID;
  host: string;
  port: number;
  /** encrypted at rest */
  connectionStringEnc: string;
  exposedPublicly: boolean;
  /**
   * The host port the container publishes when {@link exposedPublicly} is true;
   * null when not exposed.
   */
  exposedPort: number | null;
  /**
   * Per-database resource limits, or null when none set - the exact
   * {@link ResourceLimits} shape apps use, applied to the rendered stack on the
   * next provision/reroute (lib/deploy/resources.ts).
   */
  resources: ResourceLimits | null;
  /**
   * Expert override: full image ref replacing the derived engine image
   * (`DB_IMAGES[type](version)`); {@link version} is inert while set. Null =
   * derived image.
   */
  customImage: string | null;
  /**
   * Expert override: REPLACES the container command verbatim. Redis's default
   * command carries `--requirepass <password>` - omitting it from a custom
   * command drops auth, so the UI warns. Null = image/engine default.
   */
  customCommand: string | null;
  /** Cron jobs are ON for this database - the same opt-in switch, and the same
   *  reason it rides the DTO, as `apps.cronEnabled`: the sidebar decides whether
   *  to offer the Cron jobs page from it. */
  cronEnabled: boolean;
  /**
   * Expert override: the engine's own CONFIG FILES, written next to the stack and
   * bind-mounted into the container.
   */
  mounts: DatabaseMount[];
  sizeMb: number;
  createdAt: string;
}

/**
 * One config file of a database: its name in the stack's files directory, its
 * body, and where it lands inside the container.
 */
export interface DatabaseMount {
  /** Relative path inside the stack's files dir, e.g. "postgresql.conf". */
  filePath: string;
  /** The file's body, written verbatim. */
  content: string;
  /** Absolute in-container path the file is bind-mounted at. */
  mountPath: string;
}

export type S3Provider =
  | "aws"
  | "cloudflare-r2"
  | "backblaze-b2"
  | "minio"
  | "digitalocean"
  | "wasabi"
  | "other";

export type DestinationStatus = "connected" | "error" | "unverified";

/**
 * Where backup artifacts are kept.
 */
export type DestinationKind = "s3" | "server";

export interface BackupDestination {
  id: ID;
  /** Owning team. Legacy rows are backfilled to the first team on hydrate. */
  teamId: ID;
  name: string;
  kind: DestinationKind;
  /* ---- kind: "s3" ---- */
  provider: S3Provider | null;
  endpoint: string | null;
  region: string | null;
  bucket: string | null;
  /** encrypted at rest */
  accessKeyEnc: string | null;
  secretKeyEnc: string | null;
  /**
   * Opt out of the SSRF guard on `endpoint`, so a bucket on the operator's own
   * private network is reachable at all.
   */
  allowPrivateEndpoint: boolean;
  /**
   * Advanced quirk flags for this one store (`--s3-sign-accept-encoding=false`),
   * as typed. NULL means none. Validated against the allowlist in
   * `lib/backups/s3-args.ts`; the agent applies the ones its version knows.
   */
  s3ExtraArgs: string | null;
  /* ---- kind: "server" ---- */
  /** The server holding the artifacts. */
  serverId: ID | null;
  /** Directory on that server. NULL ⇒ the agent's own managed store. */
  path: string | null;
  /**
   * The age keypair the artifacts are encrypted to. The RECIPIENT is public and is
   * all the agent gets when writing, so a storage host produces artifacts it
   * cannot itself read.
   */
  ageRecipient: string | null;
  ageIdentityEnc: string | null;
  /**
   * When the operator confirmed they had saved the recovery key. Null ⇒ the
   * destination still nudges: an encrypted backup whose only key lives inside
   * the thing that might be lost is not a backup.
   */
  recoveryKeySavedAt: string | null;
  status: DestinationStatus;
  createdAt: string;
  /**
   * The last "Test connection" verdict. `lastTestAt` null ⇒ never tested (the
   * `unverified` badge); a non-null `lastTestAt` with an empty `lastTestError` ⇒
   * the probe passed.
   */
  lastTestAt: string | null;
  lastTestError: string | null;
  /** Server whose agent served the probe (null ⇒ never tested, or removed since). */
  lastTestServerId: ID | null;
  /** Probe duration in ms (null ⇒ never tested). */
  lastTestMs: number | null;
  /**
   * Server destinations only: the headroom and the resolved root the last check
   * saw. Information for the operator, never a pre-flight gate - a dump's size
   * is unknown until it exists, so ENOSPC on the write is the real guard.
   */
  lastFreeBytes: number | null;
  lastTotalBytes: number | null;
  resolvedPath: string | null;
}

/** What a backup schedule / run targets. */
export type BackupTargetKind = "database" | "app";

/** `canceled` spelled the way `deployments.status` already spells it, so the two
 *  "somebody pressed Stop" states read the same everywhere in the UI. */
export type BackupRunStatus = "running" | "success" | "failed" | "canceled";

export interface Backup {
  id: ID;
  /** Owning team. Legacy rows are backfilled to the first team on hydrate. */
  teamId: ID;
  name: string;
  /**
   * Whether this schedule backs up a database or a project. Legacy rows (which
   * could only target a database) are backfilled to `"database"` on hydrate.
   */
  targetKind: BackupTargetKind;
  databaseId: ID | null;
  /** Set when `targetKind === "app"`; otherwise null. */
  appId: ID | null;
  destinationId: ID;
  schedule: string; // cron
  /** IANA zone the cron is read in. "UTC" for every schedule made before it
   *  was askable, which is what those always meant. */
  timezone: string;
  /** How many backups this schedule keeps at its destination. A COUNT, not a
   *  window: older artifacts are removed after each successful run, and the
   *  newest successful one is never removed. */
  retentionCount: number;
  lastRunAt: string | null;
  lastStatus: "success" | "failed" | "running" | "canceled" | "never";
  enabled: boolean;
  createdAt: string;
}

/**
 * One executed backup - the record of a single dump+upload (or restore source).
 */
export interface BackupRun {
  id: ID;
  /** Owning team. Legacy rows are backfilled to the first team on hydrate. */
  teamId: ID;
  /** The schedule this run came from, or null for an ad-hoc run. */
  backupId: ID | null;
  targetKind: BackupTargetKind;
  databaseId: ID | null;
  appId: ID | null;
  destinationId: ID;
  /**
   * The target's id as plain text, carried alongside `databaseId`/`appId` because
   * those two are `ON DELETE SET NULL`: deleting the app or database blanked the
   * only thing that named what an artifact belonged to, and its bytes then sat on
   * the destination with nothing left that could find them.
   */
  targetId: ID;
  /** Object key: `deplo/<teamId>/<kind>/<targetId>/<ISO-timestamp>.<ext>`. */
  objectKey: string;
  sizeBytes: number;
  /**
   * How big the artifact is once decrypted: the exact number of bytes a download
   * delivers, and so its Content-Length.
   */
  decryptedSizeBytes: number | null;
  /**
   * Hex sha256 of the artifact as written (ciphertext, before decryption) - what a
   * restore checks before feeding those bytes to anything.
   */
  sha256: string | null;
  /**
   * When the orphan sweep first saw this run's target gone.
   */
  orphanedAt: string | null;
  status: BackupRunStatus;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

/** What a cron job runs inside. Same two kinds a Backup targets. */
export type CronTargetKind = "app" | "database";

/** Which shell interprets the command. A named shell the image lacks fails the
 *  run rather than falling back - see ADR-0018. */
export type CronShell = "sh" | "bash";

/** What to do when the previous run of a job is still going. */
export type CronOverlap = "skip" | "allow";

/**
 * How a cron run ended. It is not a failure and raises no alert. - `lost` means
 * Deplo could not find out how it ended, because the agent restarted while the
 * command was in flight.
 */
export type CronRunStatus =
  "running" | "succeeded" | "failed" | "timedout" | "skipped" | "lost";

/**
 * A scheduled command inside one container of an App or a Database.
 */
export interface CronJob {
  id: ID;
  teamId: ID;
  targetKind: CronTargetKind;
  /** Set when `targetKind === "app"`; otherwise null. */
  appId: ID | null;
  /** Set when `targetKind === "database"`; otherwise null. */
  databaseId: ID | null;
  name: string;
  description: string;
  /** Compose service to exec into. Null ⇒ the target's primary container, which
   *  is the only possibility for a database. Never a container NAME: a redeploy
   *  mints new ones, so the container is resolved live before every attempt. */
  service: string | null;
  /** 5-field cron, evaluated in `timezone`. */
  schedule: string;
  /** IANA zone, validated on write. */
  timezone: string;
  shell: CronShell;
  command: string;
  enabled: boolean;
  /** Per ATTEMPT - it is the agent's `docker exec` deadline. */
  timeoutSeconds: number;
  /** Total launches per scheduled fire: 1 means no retry. */
  maxAttempts: number;
  overlap: CronOverlap;
  /** Runs kept in this job's history; older ones are pruned as runs settle. */
  keepRuns: number;
  workdir: string | null;
  user: string | null;
  lastRunAt: string | null;
  lastStatus: CronRunStatus | null;
  /** Surfaced on the job row so a job silently `skipped` for a week is visible. */
  lastSuccessAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * One scheduled fire of a {@link CronJob}, retries included. `command` and the
 * limits are frozen at insert: editing a job mid-flight must not change the
 * deadline the reaper enforces, and the history must say what actually ran.
 */
export interface CronRun {
  id: ID;
  teamId: ID;
  jobId: ID;
  status: CronRunStatus;
  /** "schedule" | "manual" - a hand-pressed Run now is not a missed schedule. */
  trigger: "schedule" | "manual";
  actor: string;
  /** The cron minute this run answers. */
  scheduledFor: string;
  startedAt: string;
  finishedAt: string | null;
  attempt: number;
  exitCode: number | null;
  /** Last 16 KiB of the final attempt - the tail, never the head. */
  stdout: string;
  stderr: string;
  /** Why it failed, or why it was skipped. Not command output. */
  error: string | null;
  command: string;
  container: string;
  timeoutSeconds: number;
  maxAttempts: number;
}

export interface ApiToken {
  id: ID;
  /** Owning team. Legacy rows are backfilled to the first team on hydrate. */
  teamId: ID;
  /**
   * The user the token acts as. A bearer request authenticated with this token
   * resolves to this principal for user-scoped fields (account, instance-admin
   * checks). Legacy rows are backfilled to the team's owner on hydrate.
   */
  userId: ID;
  name: string;
  /** sha256 of the token; raw is shown once on creation */
  tokenHash: string;
  prefix: string;
  lastUsedAt: string | null;
  createdAt: string;
}

export type ActivityType =
  | "deployment"
  | "app"
  | "project"
  | "database"
  | "domain"
  | "env"
  /** People: members, roles, access grants, team settings and ownership. */
  | "member"
  /** Credentials: API tokens, passkeys, and the two-factor policy. */
  | "security"
  /** Hosts: the fleet, the server agent, maintenance and TLS certificates. */
  | "server"
  /** Third-party connections: git providers, the GitHub App, image registries. */
  | "integration"
  /** Instance-wide settings, and what Deplo reports about itself. */
  | "instance"
  | "backup"
  | "s3"
  /** Cron jobs: a job created, edited, run or deleted. */
  | "cron"
  /** Docker cleanup: a policy change, or a sweep that reclaimed disk on a server. */
  | "cleanup"
  /** Monitoring: a settings change (e.g. the "save metrics on server" switch). */
  | "monitoring"
  /**
   * MCP: who let AI agents into this team, and when. "An agent deleted it" must
   * never be a dead end - the trail names the human who opened the door.
   */
  | "mcp";

export interface Activity {
  id: ID;
  /**
   * The database's insert order. It breaks a same-timestamp tie for both the
   * feed's ORDER BY and its keyset cursor, so it travels with the row.
   */
  seq: number;
  /** Owning team. Legacy rows are backfilled to the first team on hydrate. */
  teamId: ID;
  type: ActivityType;
  message: string;
  actor: string;
  /**
   * The human behind `actor`, when there is one. `actor` is free text and also
   * carries non-human actors ("system" / "github"), which must NEVER be attributed
   * to a person - those stay `null`, as do rows predating the column.
   */
  actorUserId: ID | null;
  /**
   * That person's identity, resolved for display - the avatar the row shows before
   * the name.
   */
  actorUser: VarAuthor | null;
  appId: ID | null;
  /** The database this happened to. A database is not an App, so it needs its
   *  own pointer; both are null for a team-level event. */
  databaseId: ID | null;
  createdAt: string;
}

/**
 * A unified shared variable (ADR-0010, multi-team per ADR-0027) - ONE variable,
 * the replacement for the shared-env group, environment-scoped, team-global and
 * instance-global models.
 */
export interface SharedVar {
  id: ID;
  /** The OWNER. `null` = instance-owned, editable only by an instance admin. */
  teamId: ID | null;
  key: string;
  /** encrypted at rest */
  valueEnc: string;
  type: "plain" | "secret";
  /** Every team the variable reaches (ADR-0027). One team ⇒ it only suggests. */
  teamIds: ID[];
  /** Reaches >1 team (or is instance-owned): injects with no link, lowest slot. */
  autoInject: boolean;
  environmentIds: ID[];
  projectIds: ID[];
  appIds: ID[];
  targets: EnvTarget[];
  createdByUserId: ID | null;
  updatedByUserId: ID | null;
  createdAt: string;
  updatedAt: string;
}

export type RegistryType = "ghcr" | "dockerhub" | "gitlab" | "generic";

/** What the credential field actually holds. Only a self-hosted registry really
 *  takes a password: GHCR, Docker Hub and GitLab all issue a token. */
export const REGISTRY_SECRET_LABEL: Record<RegistryType, string> = {
  ghcr: "Token",
  dockerhub: "Token",
  gitlab: "Token",
  generic: "Password or access token",
};

/** A container image registry used to pull/push images for deployments. */
export interface Registry {
  id: ID;
  /** Owning team. Legacy rows are backfilled to the first team on hydrate. */
  teamId: ID;
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
 * A plugin a team installed from a plugin repository (ADR-0005).
 */
export interface InstalledPlugin {
  id: ID;
  /** Owning team. Everything is team-scoped, like registries. */
  teamId: ID;
  /** The catalog plugin id, e.g. "relay". */
  catalogId: string;
  /** Frozen physical identity (container/project/stack-file/router). Computed
   * at install from `pluginSlug(catalogId, teamSlug)`; never re-derived after. */
  slug: string;
  /** The installed manifest version, e.g. "1.0.0". */
  version: string;
  createdAt: string;
}

/**
 * Where a team's alerts are delivered. The union is derived from the array so
 * there is ONE declaration - the GraphQL enum reads the same array, and the two
 * cannot drift. Everything after `telegram` is beta.
 */
export const ALL_CHANNELS = [
  "push",
  "email",
  "discord",
  "webhook",
  "slack",
  "telegram",
  "lark",
  "msteams",
  "gotify",
  "ntfy",
  "mattermost",
  "pushover",
] as const;

export type NotificationChannel = (typeof ALL_CHANNELS)[number];

/** Which transport delivers the team's email. */
export type EmailProvider = "smtp" | "resend";

/**
 * One notifiable event a team can subscribe to, catalogued with its label,
 * description and default in `lib/alerts.ts`. Every key here MUST have a real
 * emitter.
 */
export type AlertKey =
  // Deployments
  | "deployment_failed"
  | "deployment_succeeded"
  | "deployment_interrupted"
  | "git_connection_failing"
  // Apps
  | "app_crash_loop"
  // Cron jobs
  | "cron_job_failed"
  | "cron_job_succeeded"
  // Databases
  | "database_ready"
  | "database_failed"
  | "database_rebuilt"
  | "database_deleted"
  // Backups
  | "backup_succeeded"
  | "backup_failed"
  | "restore_succeeded"
  | "restore_failed"
  // Servers
  | "server_offline"
  | "server_online"
  | "server_unmanageable"
  | "server_trust_changed"
  | "server_resources_high"
  | "server_disk_low"
  | "agent_certificate_failed"
  | "cleanup_failed"
  | "teardown_abandoned"
  // This Deplo instance
  | "deplo_update_available"
  // Security
  | "member_joined"
  | "member_removed"
  | "member_access_changed"
  | "token_created"
  | "token_revoked"
  | "two_factor_policy_changed"
  | "team_ownership_changed"
  | "failed_logins"
  // Domains & TLS
  | "certificate_expiring"
  | "domain_dns_drift";

/**
 * Canonical order of every alert - the order the picker lists them in and the
 * order a stored set is normalised to. Keep it in step with `ALERT_CATEGORIES`
 * in `lib/alerts.ts` (a test pins the two together).
 */
export const ALL_ALERTS: AlertKey[] = [
  "deployment_failed",
  "deployment_succeeded",
  "deployment_interrupted",
  "git_connection_failing",
  "app_crash_loop",
  "cron_job_failed",
  "cron_job_succeeded",
  "database_ready",
  "database_failed",
  "database_rebuilt",
  "database_deleted",
  "backup_succeeded",
  "backup_failed",
  "restore_succeeded",
  "restore_failed",
  "server_offline",
  "server_online",
  "server_unmanageable",
  "server_trust_changed",
  "server_resources_high",
  "server_disk_low",
  "agent_certificate_failed",
  "cleanup_failed",
  "teardown_abandoned",
  "deplo_update_available",
  "member_joined",
  "member_removed",
  "member_access_changed",
  "token_created",
  "token_revoked",
  "two_factor_policy_changed",
  "team_ownership_changed",
  "failed_logins",
  "certificate_expiring",
  "domain_dns_drift",
];

/**
 * ONE configured destination. Flat, mirroring its row: `url`/`target`/`secret*`
 * are the shared concepts (see `notification_channels`), and only the fields this
 * `kind` uses carry meaning - the UI decides which to show.
 */
export interface NotificationChannelInstance {
  id: ID;
  kind: NotificationChannel;
  /** The team's own label, or "" - the UI falls back to the kind's own name. */
  name: string;
  enabled: boolean;
  /** The outbound endpoint: a webhook URL, a Gotify server, an ntfy server. */
  url: string;
  /** The addressee inside it: telegram chat id, ntfy topic, the email To:. */
  target: string;
  emailFrom: string;
  emailProvider: EmailProvider;
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  /** telegram bot token · gotify token · ntfy token · pushover token · SMTP password */
  secretSet: boolean;
  /** pushover user key · Resend API key */
  secret2Set: boolean;
  /** What THIS instance is subscribed to, in `ALL_ALERTS` order. */
  alerts: AlertKey[];
}

/**
 * What the channel modal sends for ONE instance, plus the plaintext credentials
 * the user actually retyped.
 */
export interface NotificationChannelInput extends Omit<
  NotificationChannelInstance,
  "id" | "secretSet" | "secret2Set"
> {
  secrets?: { secret?: string; secret2?: string };
}

/**
 * A GitHub App connected to this Deplo instance, created through GitHub's App
 * Manifest flow - one click, no hand-copied ids and keys.
 */
export interface GithubApp {
  id: ID;
  /** Owning team. Legacy rows are backfilled to the first team on hydrate. */
  teamId: ID;
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

/**
 * Which non-GitHub git host a {@link GitConnection} talks to.
 */
export type GitProviderId = "gitlab" | "bitbucket" | "gitea" | "git";

/**
 * A team's credentials for one git host, created once in Settings → Git and reused
 * by every App deploying from that host - the counterpart of a {@link
 * GithubInstallation}.
 */
export interface GitConnection {
  id: ID;
  teamId: ID;
  provider: GitProviderId;
  /** User-chosen name, e.g. "Company GitLab". */
  label: string;
  /** Origin with no trailing slash, e.g. https://gitlab.com. */
  baseUrl: string;
  /**
   * The address points inside the deployment, and an instance admin said so.
   */
  allowPrivateEndpoint: boolean;
  /** Basic-auth username for the clone URL ("oauth2", "x-token-auth", …). */
  username: string;
  /** Account the token belongs to, resolved from the provider. */
  accountLogin: string;
  avatarUrl: string;
  health: "ok" | "failing";
  /** The provider's own error when `health` is "failing"; "" otherwise. */
  healthError: string;
  /** Only when the provider reports it (GitLab does, Gitea does not). */
  tokenExpiresAt: string | null;
  lastCheckedAt: string | null;
  createdAt: string;
}

/* A channel with no stored rows resolves to `DEFAULT_ALERTS` (`lib/alerts.ts`),
 * which is why there is no "default settings" factory here any more. */
