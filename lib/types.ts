export type ID = string;

export type Role = "owner" | "member" | "viewer";

/**
 * A single thing a member is allowed to do within a team. Roles
 * (owner/member/viewer) are presets over this set; an admin can additionally
 * grant/revoke individual capabilities per member (see {@link Membership}).
 *  - deploy          create/redeploy/stop/start apps
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
   * Traefik routing: giving an app a public domain/route does NOT require this
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
   * The team's ABSOLUTE owner — the user who originally created the team, the
   * holder of the "crown" (👑). Distinct from the `owner` *role*: a team may have
   * several owner memberships ("assigned owners"), but exactly one founder. The
   * founder is immutable and unremovable by anyone (including instance admins);
   * assigned owners can be managed/removed by any owner. Absent ⇒ a legacy team
   * not yet backfilled, or one whose founder's account was deleted (`ON DELETE
   * SET NULL`), leaving it with no protected founder. See `lib/data/members.ts`.
   */
  founderUserId?: ID | null;
  /**
   * Team-wide display order of apps in the Overview grid (array of project
   * ids, first = top-left). A team-level setting, not a per-user preference, so
   * everyone sees the same arrangement; only an instance admin or a member with
   * `manage_team` may change it (see `reorderApps`). Absent ⇒ no manual order
   * yet, fall back to newest-updated-first. Stale/missing ids are tolerated:
   * `listApps` filters to live apps and appends any not listed here.
   */
  appOrder?: ID[];
  /**
   * Team-wide display order of FOLDERS in the Overview grid (folder ids, first =
   * leftmost). Folders render before ungrouped apps. Absent ⇒ fall back to
   * newest-first. Stale/missing ids are tolerated exactly like {@link appOrder}.
   */
  folderOrder?: ID[];
  createdAt: string;
}

/** A team as shown in the switcher: the user's role in it + its size. */
export interface TeamSummary extends Team {
  role: string;
  memberCount: number;
}

/**
 * A team-wide grouping of apps shown on the Overview. A project belongs to
 * at most one folder (via {@link App.folderId}); folders themselves NEST via
 * {@link parentId}, forming a tree within the team. Each folder is OWNED by the
 * user who created it (see {@link ownerUserId}) and has its own per-folder
 * permission set; the owner grants other members access. A member with
 * `manage_team` (or an instance admin) sees and manages every folder regardless
 * of ownership. Creating a folder requires the `deploy` capability — the same
 * gate as creating a project.
 */
export interface Folder {
  id: ID;
  teamId: ID;
  name: string;
  /**
   * Parent folder id for nesting, or null/absent when this folder sits at the
   * top level. A folder's children are the folders whose `parentId` equals this
   * folder's id. Cycles (a folder under its own descendant) are rejected at the
   * move boundary; a `parentId` with no matching folder is tolerated and treated
   * as top-level.
   */
  parentId?: ID | null;
  /**
   * Optional accent colour for the folder tile on the Overview, stored as a
   * normalised `#rrggbb` hex string. Absent/null ⇒ the default neutral tile.
   * The readable foreground (icon/label) is DERIVED from it at render time via
   * {@link readableTextColor}, never stored — so contrast always tracks the
   * colour and a custom HEX can't end up unreadable.
   */
  color?: string | null;
  /**
   * The folder's OWNER — the user who created it. Null/absent only for legacy
   * folders whose owner could not be backfilled, or after the owner's account is
   * deleted (the FK is `ON DELETE SET NULL`). The owner holds every capability on
   * the folder that they hold at the team level, and is the only non-super-user
   * who may share it. See {@link Folder} for the full ownership model.
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
 * A **Project** — the top-level, team-scoped CONTAINER introduced in ADR-0008.
 * Folder-like (owner + per-container grants + colour + team ordering) but it also
 * owns a set of {@link Environment}s (added in a later phase). Folders and
 * Apps live INSIDE a Project via their `projectId`; a Project never nests in
 * another Project (no `parentId`). Projects have no page of their own: they are
 * browsed on the Overview via the `/?project=<id>` drill-in (the old
 * `/projects/<slug>` route only survives as a redirect). NOT the deployable
 * app — that is a {@link App}.
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
  createdAt: string;
  updatedAt: string;
}

/**
 * The well-known ROLE of an {@link Environment} — the discriminant that keeps
 * legacy `EnvTarget` resolution and team/instance/shared-env targeting working
 * once environments become customizable. The three seeded defaults map onto the
 * first three; user-created environments are `custom`.
 */
export type EnvironmentKind =
  | "development"
  | "preview"
  | "production"
  | "custom";

/**
 * An **Environment** (ADR-0008 Phase 3) — a per-{@link Project}, first-class
 * ISOLATED deploy target. Seeded Development/Preview/Production on Project create;
 * renamable and extensible. Each will (pipeline phase) own its containers, URL(s),
 * git branch, and env vars. NOT the legacy `EnvTarget` enum — that survives only
 * as {@link kind}.
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
 * A server's health, as last OBSERVED by a live agent `Hello` probe — not a
 * lifecycle the control plane drives. Read it together with
 * [[Server.statusCheckedAt]]: the value is a timestamped observation (a cache),
 * never a gate. Nothing in the deploy path consults it; the gate there is the
 * mandatory live Hello pre-flight (ADR-0006).
 *
 *  - `provisioning` — no agent has called home yet, so there is nothing to dial.
 *    The prober SKIPS these rows; they are never demoted to offline.
 *  - `online`       — Hello answered and Docker is reachable: the server can deploy.
 *  - `warning`      — Hello answered (the agent is up and trusted) but the host is
 *                     degraded and CANNOT deploy — today that means exactly one
 *                     thing: the Docker daemon is unreachable from the agent.
 *  - `error`        — the peer answered but the exchange is broken: the agent's
 *                     certificate is not the pinned one (trust failure), it speaks
 *                     an unsupported contract version, or it returned an
 *                     application error. The box is up; its agent is wrong.
 *  - `offline`      — nothing answered: connection refused, or no reply within the
 *                     probe deadline (confirmed by a retry before we demote).
 */
export type ServerStatus =
  | "online"
  | "warning"
  | "error"
  | "offline"
  | "provisioning";

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
 * stored, never the raw token, and both carry a short automatic expiry. Consumed
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
  /**
   * Team access scope. `true` (the default a server is born with) means EVERY
   * team can target this server for its apps/databases — the historical
   * instance-wide behaviour. `false` restricts it to the teams listed in the
   * `server_teams` junction (resolved separately; not carried on this object).
   * Editable post-install from Settings → Servers; gated by `manage_infra`.
   */
  allTeams: boolean;
  /**
   * How many deployments this server runs concurrently — the per-server slot count
   * the deploy queue enforces (the Coolify `concurrent_builds` analogue). 1 (the
   * default a server is born with) = strict serialization: one deploy at a time on
   * this host, deploys on other servers still run in parallel. A same-app
   * deploy never overlaps regardless of this value. Editable from Settings →
   * Servers (instance-admin), clamped to >= 1.
   */
  deployConcurrency: number;
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
  /**
   * When [[Server.status]] was last OBSERVED (ISO) — i.e. when a probe classified
   * and recorded a result, not when the row was last written. Absent until the
   * first observation, and never fabricated: a probe that times out or is skipped
   * writes nothing rather than stamping a check it did not perform. (The throttle
   * lease is a SEPARATE column, `status_probed_at`, precisely so that "we tried"
   * can advance without "we observed" advancing with it — an inconclusive probe
   * must never leave a fresh timestamp over a stale status.)
   *
   * This is what makes the stored status honest. `status` alone is a value that
   * was true at SOME point; `status` + this stamp is a claim the UI can qualify
   * ("Online, checked 12s ago") and — past a staleness window — refuse to paint
   * at all, falling back to "Unknown" instead of a confident, stale green.
   */
  statusCheckedAt?: string;
  /**
   * The operator-facing reason behind a non-`online` status ("Docker daemon
   * unreachable — deploys to this server will fail"), from the closed set in
   * `classifyServerHealth`. Absent when `online` or never probed.
   *
   * NEVER a raw agent/gRPC error: those embed the pinned cert fingerprint, the
   * dial address and other internals. Raw detail goes to the server log; only a
   * curated string is persisted, and it is instance-admin-scoped in GraphQL.
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
 * Which git event drives an automatic deployment when auto-deploy is on:
 *  - push  a push to the repo's tracked `branch` (the historical default)
 *  - tag   any new tag pushed to the repo
 * Absent/`undefined` is treated as "push".
 */
export type GitTriggerType = "push" | "tag";

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
  /**
   * Which git event auto-deploys this app (see {@link GitTriggerType}).
   * Absent ⇒ "push". Consumed by the GitHub webhook to gate a delivery.
   */
  triggerType?: GitTriggerType;
  /**
   * Optional path globs (one per entry). When set, an automatic deployment only
   * fires if a pushed commit changed a file matching at least one glob; empty ⇒
   * deploy on any change. Matching is best-effort (fail-open when the delivery
   * carries no file list, e.g. an annotated-tag push).
   */
  watchPaths?: string[];
  /**
   * Clone the repository's git submodules (recurse-submodules) at build time.
   * Absent ⇒ false.
   */
  submodules?: boolean;
}

/**
 * How Deplo turns a repository into a runnable image. Mirrors the "build pack"
 * choice in Coolify/Dokploy/Railway. Each method runs entirely inside Docker
 * (the only build tool guaranteed present on the host):
 *  - dockerfile  build straight from a Dockerfile in the repo
 *  - railpack    Railway's BuildKit-based builder (Nixpacks' successor)
 *  - nixpacks    Nixpacks auto-detects and builds an OCI image
 *  - static      serve a directory of files with nginx (optionally SPA)
 */
export type BuildMethod =
  | "dockerfile"
  | "railpack"
  | "nixpacks"
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
   * Include files OUTSIDE the root directory in the build context. Default true —
   * the whole repository is available to the build (monorepo packages shared
   * across apps resolve). When false, the build sees only the root-directory
   * subtree. Physical enforcement of the build context is agent-side.
   */
  includeFilesOutsideRoot: boolean;
  /**
   * Skip an auto-deploy when an inbound push changed nothing inside the root
   * directory. Default false. Gates git push-triggered deploys only — a manual
   * redeploy always runs regardless.
   */
  skipUnchangedDeployments: boolean;
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
 * A persistent volume mounted into a SINGLE-CONTAINER project's one service (the
 * renderCompose path — github/git/docker-image/upload, never compose-stack
 * apps, which declare volumes in their own YAML). Gated in the UI by
 * !usesComposeStack(project). Distinct from `App.mounts`, which writes
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
 *  - "app": a bind mount of a path INSIDE the project's isolated files dir
 *    (`projectPath`, relative, e.g. "config.toml" or "uploads"). The same
 *    sandbox the `./<x>` compose convention targets; rendered to the absolute
 *    files dir at deploy time. No grant needed — it can't escape the project.
 *  - "host": a bind mount of a real HOST filesystem path (`hostPath`). The host
 *    is docker-only and shared across teams, so a user-typed host path is a
 *    cross-tenant footgun — only users with the `canMountHostVolumes` grant (or
 *    instance admins) may add one. Enforced server-side in setAppVolumes.
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
  /** Absolute in-container mount path, e.g. "/data". UNIQUE PER PROJECT. */
  mountPath: string;
  /** Mount read-only (`:ro`). Defaults to false (read-write). */
  readOnly: boolean;
}

/**
 * Per-app resource limits — caps applied to the app's container(s) at deploy
 * time so a runaway app can't starve its neighbours on a shared host. Every
 * field is INDEPENDENTLY optional: `null` ⇒ that dimension is uncapped. An
 * app with no limits at all has `App.resources === null` (assembled from an
 * all-NULL row), so its rendered stack is byte-identical to the historical one.
 *
 * Units are normalized so each stored value is a clean integer: memory in
 * MEBIBYTES, disk in GIBIBYTES, CPU in MILLI-CPUs (`1000` = one core). The
 * mapping to `docker compose up` container keys (the non-swarm form, the only
 * one deplo's agent honors) lives in `lib/deploy/resources.ts`; validation and
 * clamping in `cleanResourceLimits` (`lib/data/apps.ts`).
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
  /** Relative CPU weight under contention, 2–262144 → `cpu_shares`. */
  cpuShares: number | null;
  /** Pin to specific host cores, e.g. "0,2-3" → `cpuset`. */
  cpuset: string | null;
  /** Max processes/threads (fork-bomb guard) → `pids_limit`. */
  pidsLimit: number | null;
  /** `/dev/shm` size, MiB → `shm_size`. */
  shmSizeMb: number | null;
  /**
   * Writable-layer disk quota, GiB → `storage_opt.size`. HOST-GATED: only takes
   * effect where the Docker storage driver supports quotas (overlay2 on XFS with
   * pquota, or devicemapper); on other hosts `compose up` rejects it. Left null
   * (the default) everywhere unless an operator opts in.
   */
  storageGb: number | null;
  /** Max open file descriptors → `ulimits.nofile` (soft = hard). */
  nofile: number | null;
  /** Max processes for the container user → `ulimits.nproc` (soft = hard). */
  nproc: number | null;
  /** OOM-killer priority, -1000..1000 → `oom_score_adj` (higher = killed first). */
  oomScoreAdj: number | null;
}

export interface App {
  id: ID;
  name: string;
  slug: string;
  teamId: ID;
  /**
   * The folder this project lives in on the Overview, or null/absent when it
   * sits at the top level (ungrouped). Folders are a team-wide, single-level
   * grouping (see {@link Folder}); a project belongs to at most one. A folderId
   * with no matching folder is tolerated and treated as ungrouped.
   */
  folderId?: ID | null;
  /**
   * The {@link Project} this app belongs to, or null/absent when it sits at
   * the team top level (ADR-0008, additive). Mutually exclusive with `folderId`
   * since ADR-0009: an app lives in one place — a folder, or an environment
   * of a project.
   */
  projectId?: ID | null;
  /**
   * The {@link Environment} (of `projectId`'s Project) this app LIVES in —
   * ADR-0009's membership axis: each environment of a project holds its own
   * apps, like a sub-folder picked from the project's environment dropdown.
   * null/absent outside a project. Kept coherent with `projectId` by the data
   * layer (entering a project defaults to its default environment).
   */
  environmentId?: ID | null;
  serverId: ID;
  /**
   * Set on a server MOVE when the OLD server still holds this app's data: the
   * source host the next successful deploy on `serverId` must copy the data volumes
   * + files dir FROM (host-to-host). Cleared by that deploy once the copy + old-host
   * teardown finish. null in the common case (no pending migration). See
   * migrateWorkloadData / the deploy's post-success migration step.
   */
  migrateFromServerId?: ID | null;
  /**
   * Display logo for the project (a URL or local /templates/<x> path). Defaulted
   * from the template's logo when deployed from one, editable from settings.
   * Null ⇒ fall back to a generic icon. NOT the Docker image (`dockerImage`).
   */
  logo: string | null;
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
   * (renderCompose) — docker-managed named volumes and (for privileged users)
   * host bind mounts. null/absent for compose-stack apps and apps that
   * never added one — so renderCompose emits no `volumes:` keys and the stack
   * stays byte-identical (no reroute churn). See {@link VolumeMount}.
   */
  volumes?: VolumeMount[] | null;
  build: BuildConfig;
  productionUrl: string | null;
  status: AppStatus;
  autoDeploy: boolean;
  /**
   * Per-app resource caps applied at deploy time, or `null` when the app has no
   * limits set (the default). See {@link ResourceLimits}.
   */
  resources: ResourceLimits | null;
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
  appId: ID;
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

export type EnvTarget = "production" | "preview";

/** Canonical ordered list of every env target. (`development` died with dev
 * mode — migration 0041 stripped its junction rows.) */
export const ALL_ENV_TARGETS: EnvTarget[] = ["production", "preview"];

/**
 * Keep only valid targets, deduped and in canonical order; fall back to every
 * target if none survive. The UI no longer offers a target picker (an App
 * belongs to exactly ONE Environment — the production/preview axis is a legacy
 * storage detail), so a write that names no target means "every runtime".
 */
export function sanitizeTargets(targets: EnvTarget[]): EnvTarget[] {
  const kept = ALL_ENV_TARGETS.filter((t) => targets.includes(t));
  return kept.length ? kept : [...ALL_ENV_TARGETS];
}

/**
 * Who created or last modified a variable. `null` when the author's account was
 * deleted (the FK is ON DELETE SET NULL) or the row predates authorship tracking
 * (migration 0029 does not backfill) — the UI renders "—".
 *
 * Identity fields only: never an email, never a hash. Authorship is METADATA, not
 * a value, so it is safe in a DTO whose `value` stays masked.
 */
export interface VarAuthor {
  id: ID;
  name: string;
  username: string;
  avatarColor: string;
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
 * A GLOBAL environment variable — injected into services without being attached
 * per-project. Two scopes: `team` (every project in one team) and `instance`
 * (every project of every team, instance-admin managed). Both share this shape;
 * the scope determines storage table, gating, and deploy precedence (instance is
 * the lowest, then team, then a project's own var, then shared groups).
 */
/**
 * Global env scope. Only `instance` remains: team-global vars became team-wide
 * SHARED vars (ADR-0010), so there is no `team` scope any more — the union is kept
 * (rather than deleted) so the manager keeps one explicit, checkable scope name.
 */
export type GlobalEnvScope = "instance";

export interface GlobalEnvVar {
  id: ID;
  key: string;
  valueEnc: string; // encrypted at rest
  targets: EnvTarget[];
  type: "plain" | "secret";
  createdByUserId: ID | null;
  updatedByUserId: ID | null;
  createdAt: string;
  updatedAt: string;
}

/** DTO sent to the client: secret values are masked. */
export interface GlobalEnvVarDTO {
  id: ID;
  key: string;
  value: string; // masked for secrets
  masked: boolean;
  targets: EnvTarget[];
  type: "plain" | "secret";
  createdBy: VarAuthor | null;
  updatedBy: VarAuthor | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * A custom domain's DNS verification state.
 *  - valid          an A record points straight at this project's server.
 *  - cloudflare     proxied through Cloudflare's orange-cloud: the A records are
 *                   Cloudflare's anycast IPs, which mask the origin. UNVERIFIED,
 *                   not a success — those IPs are identical for every proxied
 *                   domain on the internet, so DNS shows only that the host is
 *                   proxied, never that Cloudflare forwards it to this app's
 *                   server. Routed anyway (excluding it would break every
 *                   correctly-proxied domain) but surfaced as an open question,
 *                   distinct from both `valid` and a genuine misconfiguration.
 *  - pending        added but not yet verified (no DNS check has run).
 *  - misconfigured  resolves nowhere useful, or to an unrelated address.
 *  - error          a check failed unexpectedly (reserved).
 */
export type DomainStatus =
  | "valid"
  | "cloudflare"
  | "pending"
  | "misconfigured"
  | "error";

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
 *  - letsencrypt  the HTTP-01 ACME resolver baked into the proxy (resolved via
 *                 `certResolver()` / `DEPLO_CERT_RESOLVER`).
 *  - cloudflare   a DNS-01 resolver named `cloudflare` for real domains whose
 *                 DNS is on Cloudflare (the proxy must define this resolver).
 *  - none         no certificate — serve plain HTTP on the `web` entrypoint, no
 *                 TLS labels, no forced upgrade. The default for every NEW
 *                 domain (stored explicitly): a cert is only registered when
 *                 the user — or a template that expects HTTPS — opts in.
 * Absent ⇒ `letsencrypt` (back-compat with domains created before this field).
 */
export type CertProvider = "letsencrypt" | "cloudflare" | "none";

export interface Domain {
  id: ID;
  appId: ID;
  name: string;
  status: DomainStatus;
  primary: boolean;
  redirectTo: string | null;
  ssl: boolean;
  /**
   * "auto"  the zero-config nip.io hostname Deplo generates once per project
   * (already routed, no DNS setup). "custom"  a domain the user added and must
   * point at this server. Defaults to "custom" when absent.
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
   * paths to different apps/ports (each is its own `Domain` row). Stored
   * normalised: a single leading slash, no trailing slash, never a scheme/host,
   * never a backtick (it is interpolated into a Traefik backtick literal).
   * Absent/empty ⇒ a `Host()`-only rule, the long-standing behaviour. Two hosts
   * with different prefixes can't share a router, so it is part of the router
   * signature; a path router is also given a `priority` above every whole-host
   * router (which would otherwise swallow the path — Traefik defaults an
   * un-pinned router's priority to its rule LENGTH), longest prefix first.
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
   * behaviour. Ignored for single-image services (which use `port`).
   */
  service?: string;
  createdAt: string;
}

/**
 * An HTTP Basic Auth credential that protects EVERY domain of a project. When a
 * project has one or more of these, the deploy/reroute renderers inject a
 * generated Traefik `basicauth` middleware (built from all of them) at the head
 * of every router's middleware chain, so all the project's hostnames sit behind
 * the same browser login prompt. `passwordEnc` is the AES-GCM-encrypted password
 * (reversible, like {@link EnvVar.valueEnc}) so the htpasswd line is re-derived
 * on every render; it is write-only over the API and never returned to a client.
 */
export interface BasicAuthUser {
  id: ID;
  appId: ID;
  username: string;
  /** AES-GCM-encrypted password. Reversible (re-hashed to htpasswd at render),
   * write-only over the API. */
  passwordEnc: string;
  createdAt: string;
  updatedAt: string;
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
  /**
   * The engine login the connection string authenticates as, and the user the
   * backup dump execs as (except mysql/mariadb, which always dump as `root` —
   * see {@link file://./data/backups.ts} `dumpUserFor`). Create-only: the
   * official images apply the `*_USER` env var only on first init against an
   * empty volume, so it is display-only on edit. Defaults per engine at creation
   * (`app`, or `default` for redis); legacy rows are backfilled the same way.
   */
  username: string;
  /**
   * The logical database created on first init (`POSTGRES_DB` / `MYSQL_DATABASE`
   * / `CLICKHOUSE_DB` / the mongo default DB). This is the single source of truth
   * for the logical DB name: the compose `*_DB` env, the connection-string path
   * segment, and the backup dump target all read it. Defaults to the service
   * name (`db-<name>`) at creation and legacy rows are backfilled to {@link host}
   * (which equals that service name), so existing databases dump the identical
   * database. Redis has no logical DB, so its stored value is an inert
   * placeholder. Create-only / display-only, like {@link username}.
   */
  dbName: string;
  status: DatabaseStatus;
  serverId: ID;
  host: string;
  port: number;
  /** encrypted at rest */
  connectionStringEnc: string;
  exposedPublicly: boolean;
  /**
   * The host port the container publishes when {@link exposedPublicly} is true;
   * null when not exposed. Distinct from {@link port} (the in-container engine
   * port): the compose maps `exposedPort:port` so a user can publish on a free
   * host port instead of colliding with the engine's default on that host.
   */
  exposedPort: number | null;
  /**
   * Per-database resource limits, or null when none set — the exact
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
   * command carries `--requirepass <password>` — omitting it from a custom
   * command drops auth, so the UI warns. Null = image/engine default.
   */
  customCommand: string | null;
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

/** What a backup schedule / run targets. */
export type BackupTargetKind = "database" | "app";

export type BackupRunStatus = "running" | "success" | "failed";

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
  /** Set when `targetKind === "service"`; otherwise null. */
  appId: ID | null;
  destinationId: ID;
  schedule: string; // cron
  retentionDays: number;
  lastRunAt: string | null;
  lastStatus: "success" | "failed" | "running" | "never";
  enabled: boolean;
  createdAt: string;
}

/**
 * One executed backup — the record of a single dump+upload (or restore source).
 * Persisted in the `backup_runs` table; the source of truth for artifact listing
 * and restore. `backupId` is null for an ad-hoc "back up now" run with no owning
 * schedule.
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
  /** S3 object key: `deplo/<teamId>/<kind>/<targetId>/<ISO-timestamp>.<ext>`. */
  objectKey: string;
  sizeBytes: number;
  status: BackupRunStatus;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
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
  | "member"
  | "backup"
  | "s3"
  /** Docker cleanup: a policy change, or a sweep that reclaimed disk on a server. */
  | "cleanup"
  /** Monitoring: a settings change (e.g. the "save metrics on server" switch). */
  | "monitoring";

export interface Activity {
  id: ID;
  /** Owning team. Legacy rows are backfilled to the first team on hydrate. */
  teamId: ID;
  type: ActivityType;
  message: string;
  actor: string;
  /**
   * The human behind `actor`, when there is one. `actor` is free text and also
   * carries non-human actors ("system" / "github"), which must NEVER be attributed
   * to a person — those stay `null`, as do rows predating the column.
   */
  actorUserId: ID | null;
  appId: ID | null;
  createdAt: string;
}

/**
 * A unified shared variable (ADR-0010) — ONE variable owned by a team, the
 * replacement for the shared-env group, environment-scoped, and team-global
 * models. It reaches an app through any of three sharing MODES plus a per-app
 * link:
 *  - `teamWide` — every app in the team.
 *  - `environmentIds` — apps living in one of these {@link Environment}s.
 *  - `projectIds` — apps in one of these {@link Project} containers (whitelist).
 *  - `appIds` — an explicit per-app link attached from the app UI.
 * `targets` is the orthogonal runtime axis (production/preview),
 * defaulting to both. Deploy selection/precedence: lib/deploy/env-resolve.ts.
 */
export interface SharedVar {
  id: ID;
  teamId: ID;
  key: string;
  /** encrypted at rest */
  valueEnc: string;
  type: "plain" | "secret";
  teamWide: boolean;
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
 * minimal: no `status`, `url`, `appId`, or token reference. Status is read
 * live from the container at query time; the URL is computed from the stored
 * `slug`; the (MCP) app holds no credential of its own — it relays the caller's
 * `deplo_` token.
 *
 * The `slug` is the FROZEN physical identity of the container — its name,
 * compose project, stack file, and Traefik path router all key off it. It is
 * computed once at install (`pluginSlug(catalogId, teamSlug)`) and persisted, so a
 * later team rename never orphans the running container/router — exactly as a
 * project's slug is frozen and `renameApp` never touches it.
 */
export interface InstalledPlugin {
  id: ID;
  /** Owning team. Everything is team-scoped, like registries. */
  teamId: ID;
  /** The catalog app id, e.g. "mcp". */
  catalogId: string;
  /** Frozen physical identity (container/project/stack-file/router). Computed
   * at install from `pluginSlug(catalogId, teamSlug)`; never re-derived after. */
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
