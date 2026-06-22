export type ID = string;

export type Role = "owner" | "member" | "viewer";

/**
 * A single thing a member is allowed to do within a team. Roles
 * (owner/member/viewer) are presets over this set; an admin can additionally
 * grant/revoke individual capabilities per member (see {@link Membership}).
 *  - deploy          create/redeploy/stop/start projects & dev environments
 *  - manage_domains  add/verify/route/remove custom domains
 *  - manage_env      edit project & shared environment variables
 *  - manage_files    browse/edit/upload/delete a project's files dir
 *  - manage_infra    servers, databases, S3, registries, backups, GitHub apps
 *  - manage_members  invite/create/remove members, change their roles
 *  - manage_team     rename the team, edit team settings, delete the team
 *  - view            read-only access to the dashboard (always implied)
 */
export type Capability =
  | "deploy"
  | "manage_domains"
  | "manage_env"
  | "manage_files"
  | "manage_infra"
  | "manage_members"
  | "manage_team"
  | "view";

/** Canonical ordered list of every capability (drives the settings UI). */
export const ALL_CAPABILITIES: Capability[] = [
  "view",
  "deploy",
  "manage_domains",
  "manage_env",
  "manage_files",
  "manage_infra",
  "manage_members",
  "manage_team",
];

export interface User {
  id: ID;
  email: string;
  /**
   * Unique, instance-wide handle — the public identity. Shown (with no email)
   * in the member picker and the global users list, and used to add an existing
   * user to a team. Lowercased, `[a-z0-9_-]`, unique across the instance.
   */
  username: string;
  name: string;
  /** scrypt hash, never leaves the server */
  passwordHash: string;
  /**
   * Legacy instance-wide role. Retained for back-compat with documents written
   * before per-team memberships; the source of truth for what a user can do is
   * now their {@link Membership} in the active team.
   */
  role: Role;
  /**
   * Global-scoped admin. Instance admins manage all users platform-wide: the
   * Settings → Users list, minting registration links, and the per-user admin
   * editor. The first account (setup) is an instance admin. Distinct from
   * per-team capabilities (which only ever scope to one team).
   */
  isInstanceAdmin?: boolean;
  /**
   * Globally suspended: cannot sign in and is treated as having no access until
   * re-activated. Does not delete the account or its memberships.
   */
  suspended?: boolean;
  /**
   * Instance-wide grant: may publish container ports declared in a compose
   * stack — a service's `ports:` (bound to the host) or `expose:`. Orthogonal to
   * Traefik routing: giving a service a public domain/route does NOT require this
   * grant. Security-sensitive, so it is opt-in per user (granted from Settings →
   * Users) rather than implied by a team capability. Instance admins hold it
   * implicitly.
   */
  canExposePorts?: boolean;
  /**
   * Instance-wide grant: may bind-mount a real HOST filesystem path into a
   * container (NOT docker-managed named/anonymous volumes). A host path is a
   * cross-tenant footgun on the shared docker host, so it is opt-in per user
   * (granted from Settings → Users). Instance admins hold it implicitly.
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
}

/**
 * A user's membership of a team — the join row that makes the app multi-tenant.
 * `capabilities` is the *effective* set the member has in that team; on
 * create/invite it is seeded from the role preset (see CAPABILITY_PRESETS) but
 * can then be edited per member. `role` is kept as a human label / default.
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
 * A single-use link that lets a new person self-register a brand-new account
 * AND their own team (like the first-run setup, not a team invite). Minted by a
 * member with `manage_members`; only the token hash is stored. Using it creates
 * a User + a Team (the registrant picks a unique team name) + an owner
 * Membership, then signs them in. Distinct from {@link Invite}, which adds
 * someone to an EXISTING team.
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
   * Team-wide display order of projects in the Overview grid (array of project
   * ids, first = top-left). A team-level setting, not a per-user preference, so
   * everyone sees the same arrangement; only an instance admin or a member with
   * `manage_team` may change it (see `reorderProjects`). Absent ⇒ no manual order
   * yet, fall back to newest-updated-first. Stale/missing ids are tolerated:
   * `listProjects` filters to live projects and appends any not listed here.
   */
  projectOrder?: ID[];
  createdAt: string;
}

/** A team as shown in the switcher: the user's role in it + its size. */
export interface TeamSummary extends Team {
  role: string;
  memberCount: number;
}

export type ServerStatus = "online" | "offline" | "provisioning" | "error";

/**
 * The agent trust + reachability material for a server (PLAN Part B). EVERY
 * server — including the host running Deplo — gains it through the call-home
 * bootstrap: the agent (installed on the host via install-agent.sh) generates
 * its own key, the control plane signs its CSR, and the cert's fingerprint is
 * pinned here so the control plane can authenticate that exact agent (and revoke
 * it on removal, P6). Cert material is the pinning identity, not a secret (it is
 * a public certificate), so it is stored as-is; the pre-bootstrap token, which IS
 * secret-shaped, is stored hashed in {@link ServerBootstrap}.
 */
export interface ServerAgent {
  /** The TCP port the agent's gRPC listener is on (default 9443). */
  port: number;
  /**
   * sha256(DER) of the agent's signed server cert, lowercase hex — the pinning
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
 * registration-link pattern ([[RegistrationLink]]) — only the token's sha256 is
 * stored, never the raw token — but ADDS a short expiry (registration links do
 * not expire; a provisioning token is more dangerous, so it must). Consumed
 * single-use when the agent calls home.
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
  createdAt: string;
  /**
   * Agent trust material — present once a server is provisioned (Part B). Absent
   * only while a server is still in `provisioning` (before its agent has called
   * home). Applies to every server, the host running Deplo included.
   */
  agent?: ServerAgent;
  /**
   * The pending call-home bootstrap secret — present only while a server is
   * `provisioning`, cleared once its agent has been provisioned (Part B, P2).
   */
  bootstrap?: ServerBootstrap;
  /**
   * Last time the agent answered (ISO) — fed by the heartbeat (P5). A CACHE
   * behind the live-read health check, never the source of truth.
   */
  lastSeenAt?: string;
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

export type ProjectStatus =
  | "active"
  | "building"
  | "error"
  | "queued"
  | "idle"
  // Transient: the user pressed Stop and the container is being brought down.
  // Persisted (so it survives reload and every client sees it) until the stop
  // completes and the project settles to "idle".
  | "stopping";

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
 * The internal `DeploySource` strings are lowercase and hyphenated
 * ("docker-image"), but the GraphQL `DeploySource` enum exposes uppercase,
 * underscored value *names* (GITHUB, DOCKER_IMAGE …) — GraphQL enum names can't
 * contain hyphens. A wire request must carry the enum *name*, so map the
 * runtime value to its enum name before sending it as a GraphQL variable.
 */
export function deploySourceEnumName(source: DeploySource): string {
  return source.replace(/-/g, "_").toUpperCase();
}

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

/**
 * A persistent volume mounted into a SINGLE-CONTAINER project's one service (the
 * renderCompose path — github/git/docker-image/upload, never compose-stack
 * projects, which declare volumes in their own YAML). Gated in the UI by
 * !usesComposeStack(project). Distinct from `Project.mounts`, which writes
 * template CONFIG FILES to disk and bind-mounts them (content-bearing); a
 * VolumeMount carries no content — it is data that survives redeploys.
 *
 * Three kinds, discriminated by `type` (absent ⇒ "named", for back-compat):
 *  - "named": a docker-MANAGED volume. The on-host volume name is NOT `name` —
 *    it is namespaced per-project at render time (deplo-<slug>-<name>, see
 *    `hostVolumeName`) so it can never collide with or leak into another team's
 *    project on the shared host (the same isolation reason compose strips
 *    container_name). Deriving from the slug at render time (never storing the
 *    host name) means a rename can't orphan data and `name` stays a label.
 *  - "project": a bind mount of a path INSIDE the project's isolated files dir
 *    (`projectPath`, relative, e.g. "config.toml" or "uploads"). The same
 *    sandbox the `./<x>` compose convention targets; rendered to the absolute
 *    files dir at deploy time. No grant needed — it can't escape the project.
 *  - "host": a bind mount of a real HOST filesystem path (`hostPath`). The host
 *    is docker-only and shared across teams, so a user-typed host path is a
 *    cross-tenant footgun — only users with the `canMountHostVolumes` grant (or
 *    instance admins) may add one. Enforced server-side in setProjectVolumes.
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
  type?: "named" | "project" | "host";
  /**
   * Human label, lowercase-kebab, UNIQUE PER PROJECT. Namespaced on the host.
   * Named volumes only (ignored for "project"/"host" mounts).
   */
  name: string;
  /**
   * Path RELATIVE to the project's isolated files dir, e.g. "config.toml" or
   * "uploads". Project mounts only (type === "project"); never contains "..".
   * Absent/ignored for named and host mounts.
   */
  projectPath?: string;
  /**
   * Absolute HOST path to bind-mount, e.g. "/srv/data". Host mounts only
   * (type === "host"); absent/ignored for named and project mounts.
   */
  hostPath?: string;
  /** Absolute in-container mount path, e.g. "/data". UNIQUE PER PROJECT. */
  mountPath: string;
  /** Mount read-only (`:ro`). Defaults to false (read-write). */
  readOnly: boolean;
}

export interface Project {
  id: ID;
  name: string;
  slug: string;
  teamId: ID;
  serverId: ID;
  framework: FrameworkId;
  /**
   * Display logo for the project (a URL or local /templates/<x> path). Defaulted
   * from the template's logo when deployed from one, editable from settings.
   * Null ⇒ fall back to the framework icon. NOT the Docker image (`dockerImage`).
   */
  logo: string | null;
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
  /**
   * User-managed persistent volumes for the SINGLE-CONTAINER deploy path
   * (renderCompose) — docker-managed named volumes and (for privileged users)
   * host bind mounts. null/absent for compose-stack projects and projects that
   * never added one — so renderCompose emits no `volumes:` keys and the stack
   * stays byte-identical (no reroute churn). See {@link VolumeMount}.
   */
  volumes?: VolumeMount[] | null;
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

export type LogLevel =
  | "info"
  | "warn"
  | "error"
  | "debug"
  | "command"
  | "success";

export interface LogLine {
  ts: string;
  level: LogLevel;
  text: string;
}

export type EnvTarget = "production" | "preview" | "development";

/** Canonical ordered list of every env target. */
export const ALL_ENV_TARGETS: EnvTarget[] = [
  "production",
  "preview",
  "development",
];

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

/**
 * The Traefik entrypoint a domain's router binds to. Mirrors the two entrypoints
 * defined in the proxy's static config (install.sh): `websecure` (:443, TLS) and
 * `web` (:80, plain HTTP). Defaults to `websecure` when absent — the
 * long-standing behaviour where every router served HTTPS.
 */
export type DomainEntrypoint = "websecure" | "web";

/**
 * How a domain's TLS certificate is issued — the user's *choice*, distinct from
 * `ssl` (whether a cert is currently active, derived from DNS verification):
 *  - letsencrypt  the HTTP-01 ACME resolver baked into the proxy (the default,
 *                 resolved via `certResolver()` / `DEPLO_CERT_RESOLVER`).
 *  - cloudflare   a DNS-01 resolver named `cloudflare` for real domains whose
 *                 DNS is on Cloudflare (the proxy must define this resolver).
 *  - none         no certificate — serve plain HTTP on the `web` entrypoint, no
 *                 TLS labels, no forced upgrade.
 * Absent ⇒ `letsencrypt` (back-compat with domains created before this field).
 */
export type CertProvider = "letsencrypt" | "cloudflare" | "none";

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
  /**
   * Traefik entrypoint this host's router binds to. Absent ⇒ `websecure` (the
   * long-standing default). `web` serves plain HTTP on :80.
   */
  entrypoint?: DomainEntrypoint;
  /**
   * How TLS is issued for this host (see {@link CertProvider}). Absent ⇒
   * `letsencrypt`. `none` means no certificate — the router serves plain HTTP
   * and is forced onto the `web` entrypoint regardless of `entrypoint`.
   */
  certProvider?: CertProvider;
  /**
   * Traefik middlewares applied to this host's router, in order, emitted as
   * `traefik.http.routers.<key>.middlewares=<m1>,<m2>,…`. Each entry is a
   * middleware reference the proxy already defines (e.g. `redirect-https` or a
   * provider-qualified `auth@file`). Absent/empty ⇒ no middleware label, the
   * long-standing behaviour. Two hosts with different chains can't share a
   * router, so the chain is part of the router-grouping signature.
   */
  middlewares?: string[];
  /**
   * Path prefix this host's router matches, e.g. `/api`. The router rule becomes
   * `Host(`name`) && PathPrefix(`/api`)`, so one hostname can route different
   * paths to different services/ports (each is its own `Domain` row). Stored
   * normalised: a single leading slash, no trailing slash, never a scheme/host,
   * never a backtick (it is interpolated into a Traefik backtick literal).
   * Absent/empty ⇒ a `Host()`-only rule, the long-standing behaviour. Two hosts
   * with different prefixes can't share a router, so it is part of the router
   * signature; a longer prefix gets a higher router `priority` so it wins.
   */
  pathPrefix?: string;
  /**
   * Strip {@link pathPrefix} from the request path before forwarding to the app,
   * via a generated Traefik `stripprefix` middleware prepended to {@link
   * middlewares} (so user middlewares see the already-stripped path the app
   * sees). Meaningless without a `pathPrefix` and dropped when absent. Absent/
   * false ⇒ forward the path unchanged, the long-standing behaviour.
   */
  stripPrefix?: boolean;
  /**
   * COMPOSE/template stacks only: which compose service this host's router
   * targets. The container port comes from that service's compose definition
   * (the compose file owns the port — there is no per-domain `port` override on
   * a stack), so `service` is the compose analogue of `port`. Absent ⇒ the
   * stack's default exposed service (`expose`/`exposes`), the long-standing
   * behaviour. Ignored for single-image projects (which use `port`).
   */
  service?: string;
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
  /** Owning team. Legacy rows are backfilled to the first team on hydrate. */
  teamId: ID;
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
  /** Owning team. Legacy rows are backfilled to the first team on hydrate. */
  teamId: ID;
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
  /** Owning team. Legacy rows are backfilled to the first team on hydrate. */
  teamId: ID;
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
  | "project"
  | "database"
  | "domain"
  | "env"
  | "member"
  | "backup"
  | "s3";

export interface Activity {
  id: ID;
  /** Owning team. Legacy rows are backfilled to the first team on hydrate. */
  teamId: ID;
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
  /** Owning team. Legacy rows are backfilled to the first team on hydrate. */
  teamId: ID;
  name: string;
  description: string;
  variables: SharedEnvVar[];
  /** ids of the projects this group is attached to */
  projectIds: ID[];
  /**
   * The runtimes this group reaches, same axis as a per-project var. A group
   * flows into a project's dev container only if it includes `development`.
   * Legacy groups persisted before this field default to all three targets.
   */
  targets: EnvTarget[];
  createdAt: string;
  updatedAt: string;
}

export type RegistryType = "ghcr" | "dockerhub" | "gitlab" | "generic";

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
 * An app a team installed from the app repository (ADR-0005). An installed app
 * is a host-managed container — NOT a project — so this row is deliberately
 * minimal: no `status`, `url`, `projectId`, or token reference. Status is read
 * live from the container at query time; the URL is computed from the stored
 * `slug`; the (MCP) app holds no credential of its own — it relays the caller's
 * `deplo_` token.
 *
 * The `slug` is the FROZEN physical identity of the container — its name,
 * compose project, stack file, and Traefik path router all key off it. It is
 * computed once at install (`appSlug(catalogId, teamSlug)`) and persisted, so a
 * later team rename never orphans the running container/router — exactly as a
 * project's slug is frozen and `renameProject` never touches it.
 */
export interface InstalledApp {
  id: ID;
  /** Owning team. Everything is team-scoped, like registries. */
  teamId: ID;
  /** The catalog app id, e.g. "mcp". */
  catalogId: string;
  /** Frozen physical identity (container/project/stack-file/router). Computed
   * at install from `appSlug(catalogId, teamSlug)`; never re-derived after. */
  slug: string;
  /** The installed manifest version, e.g. "1.0.0". */
  version: string;
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

/** Whole persisted database shape. */
export interface DeploData {
  users: User[];
  teams: Team[];
  /** Per-team membership join rows — who belongs to which team and with what capabilities. */
  memberships: Membership[];
  /** Outstanding & historical team invitations. */
  invites: Invite[];
  /** Single-use new-account registration links (account + own team). */
  registrationLinks: RegistrationLink[];
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
  /**
   * Notification settings, keyed by team id. A team with no entry yet falls
   * back to the default settings (see `defaultNotificationSettings`).
   */
  notificationSettings: Record<ID, NotificationSettings>;
  sharedEnvGroups: SharedEnvGroup[];
  registries: Registry[];
  githubApps: GithubApp[];
  githubInstallations: GithubInstallation[];
  /** Dev SSH users — the sole source of truth for the SSH gateway projection. */
  devSshUsers: DevSshUser[];
  /** Apps a team installed from the app repository (ADR-0005). Host-managed
   * containers, never projects; status is live, never stored here. */
  installedApps: InstalledApp[];
}

/** Default notification settings for a team that has none persisted yet. */
export function defaultNotificationSettings(): NotificationSettings {
  return {
    channels: {
      push: { enabled: false },
      email: { enabled: false, address: "" },
      discord: { enabled: false, webhookUrl: "" },
      webhook: { enabled: false, url: "" },
    },
    events: {
      deployment_failed: true,
      deployment_succeeded: false,
      server_offline: true,
      high_resource_usage: true,
      update_available: true,
    },
  };
}
