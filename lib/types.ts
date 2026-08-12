// Type-only (erased at runtime), so the framework catalog can keep importing
// BuildMethod from here without either module ever forming a runtime cycle.
import type { FrameworkId } from "./apps/framework-catalog";

export type ID = string;

export type Role = "owner" | "member" | "viewer";

/**
 * A single thing a member is allowed to do within a team — ONE action, never a
 * bundle. A {@link Role} is a named set of these, assigned per member; the labels,
 * descriptions and browse categories live in `lib/capabilities.ts`.
 *
 * These replaced the original eight coarse capabilities (`deploy`,
 * `manage_infra`, …), each of which was really a dozen actions wearing one name —
 * so "can deploy but must not delete" or "can read files but not write them" was
 * unsayable. `LEGACY_CAPABILITY_EXPANSION` (same file) maps every old name to the
 * permissions it used to imply, and is what migration 0056 and the API's
 * back-compat path both read.
 *
 * `view` is the always-on floor: every member of a team holds it, and it is never
 * offered as a toggle.
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
 * Canonical order of every capability — the order the role editor lists them in
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
   * Unique, instance-wide handle — the public identity. Shown (with no email)
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
  /**
   * True once the account has a verified TOTP factor. Safe to expose: it says
   * whether a second factor exists, never anything about the factor itself.
   * Drives the reminder modal and the "2FA required" gate's messaging.
   */
  twoFactorEnabled: boolean;
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
   * Team-wide 2FA policy. When true, a member without a verified second factor
   * resolves no capabilities in this team, over the UI and the bearer API alike.
   * Never auto-enabled; enabling is refused unless the actor has 2FA themselves.
   */
  requireTwoFactor?: boolean;
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

/**
 * Who a team IS, with none of its settings — what the shell needs to name the
 * team you are working in, on every page.
 *
 * Distinct from {@link Team} on purpose: the full row is a team-wide READ, and a
 * member limited to part of the team is refused it. The topbar is not a setting.
 */
export type TeamIdentity = Pick<Team, "id" | "name" | "slug">;

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
   * A server bought purely to HOLD BACKUPS: the agent is installed, Docker is
   * not, and nothing is ever deployed here. Set by the storage-only installer.
   *
   * It changes two things and only two: the Docker readiness/health checks are
   * skipped (a storage box without Docker is healthy, not broken), and the
   * server is absent from every deploy-target picker while staying available as
   * a backup destination.
   */
  storageOnly: boolean;
  /**
   * A server bought purely to COMPILE: Docker is installed, Traefik is not, and no
   * app of any team runs here. It builds images for the hosts that do, which receive
   * them over the image relay.
   *
   * The twin of {@link storageOnly} and exclusive with it. It changes two things:
   * the server drops out of every deploy-target picker (apps and databases alike),
   * and the Traefik readiness check becomes a skip rather than a warning - a build
   * server has no proxy by design. Docker is still required.
   */
  buildOnly: boolean;
  /**
   * This host's CPU architecture ("amd64" | "arm64"), observed from each Hello.
   * "" when the agent is too old to report it, which keeps the server out of the
   * build-server picker rather than risking an image the target cannot execute.
   */
  hostArch: string;
  /**
   * How many deployments this server runs concurrently — the per-server slot count
   * the deploy queue enforces. 1 (the
   * default a server is born with) = strict serialization: one deploy at a time on
   * this host, deploys on other servers still run in parallel. A same-app
   * deploy never overlaps regardless of this value. Editable from Settings →
   * Servers (instance-admin), clamped to >= 1.
   */
  deployConcurrency: number;
  /**
   * The Traefik web panel: the host's own Traefik dashboard, published here.
   * Absent = off, which is where every server starts.
   *
   * The password is deliberately NOT part of this shape. It is stored encrypted
   * so the htpasswd line can be re-derived when the stack is rewritten, and it
   * never leaves the data layer — the dashboard exposes every route and
   * certificate on the host, so its credentials get the same write-only
   * treatment as any other secret.
   */
  traefikDashboard?: { domain: string; username: string };
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
  | "stopping"
  // Transient: a backup is being put back in place. The agent stops the stack,
  // wipes it and untars the snapshot, so for the whole restore the host truthfully
  // reports nothing running — which read as a red "Not running", then "Degraded"
  // as services came back, for an operation the user had just asked for. Persisted
  // like "stopping", and settled to "active"/"error" when the restore returns.
  | "restoring";

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
   * authenticates the clone and registers the push webhook. Absent for a public
   * repo cloned anonymously — which is what a bare "Repository URL" is.
   * Mutually exclusive with {@link installationId} in practice.
   */
  connectionId?: string | null;
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
  /**
   * Reuse the owning server's Docker layer cache (and the builder's own cache
   * mounts) between this app's builds. Default true — it is what makes a redeploy
   * of an unchanged app take seconds instead of minutes. False ⇒ every build runs
   * `docker build --no-cache` with nothing carried over from the last one, which
   * is the setting for a build that reads "latest" from somewhere and must not be
   * frozen at whatever it resolved to last week.
   */
  buildCache: boolean;
  /**
   * Armed by "Clear build cache", consumed by the next build (which then runs
   * cache-less exactly once). READ-ONLY through the build config: it is set by
   * `clearAppBuildCache` and cleared by the deploy, never by a build-settings
   * save.
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
 * container. Bind mounts only (`VolumeMount.type === "host"`); docker rejects a
 * propagation option on a managed volume.
 *
 * Absent is docker's `rprivate` default: the container gets a SNAPSHOT of the
 * submounts that existed the instant it started and never follows them again —
 * so a network disk, a FUSE share or a volume another container mounts inside
 * that folder is invisible, with no error anywhere. That is what these fix:
 *  - "rslave"  — the server's mounts keep showing up inside the app (one-way).
 *  - "rshared" — two-way, so mounts the app makes appear on the server too.
 * Both need the source to be a shared mount on the host (systemd's default), or
 * docker refuses the mount with "not a shared mount".
 */
export const MOUNT_PROPAGATIONS = ["rslave", "rshared"] as const;
export type MountPropagation = (typeof MOUNT_PROPAGATIONS)[number];

/**
 * A persistent volume mounted into an app's container. Available to EVERY source:
 * a single-container app (the renderCompose path — github/git/docker-image/upload)
 * mounts it into its one service, a compose-stack app into the service named by
 * `service` (see below). Nobody has to hand-write compose YAML to get persistent
 * storage. Distinct from `App.mounts`, which writes template CONFIG FILES to disk
 * and bind-mounts them (content-bearing); a VolumeMount carries no content — it is
 * data that survives redeploys.
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
  /**
   * COMPOSE-STACK apps only: the compose service to mount into. Empty/absent ⇒
   * the stack's default service (the one a domain would route to — a published
   * port, else the first). A single-container app has exactly one service, so the
   * field is meaningless there and is always stored NULL. A name that is not in
   * the compose is a hard deploy error, never a silent remount elsewhere (that
   * would strand a database's data on the wrong container).
   */
  service?: string | null;
  /**
   * Absolute in-container mount path, e.g. "/data". UNIQUE PER PROJECT — or, for
   * a compose stack, unique per (service, path), so two services can each mount
   * their own volume at `/data`.
   */
  mountPath: string;
  /** Mount read-only (`:ro`). Defaults to false (read-write). */
  readOnly: boolean;
  /**
   * HOST binds only: whether the mount follows submounts that appear later.
   * Absent ⇒ docker's `rprivate` default. See {@link MountPropagation}. Dropped
   * for the other two kinds — a managed volume or a files-dir bind has no
   * submounts, and docker rejects the option on the former.
   */
  propagation?: MountPropagation;
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
   * Which server BUILDS this app's image, when that is not `serverId`. null is
   * "Automatic": a build-only server if the fleet has one this team can reach and
   * its arch matches, otherwise build where the app runs. Pinning `serverId` itself
   * is how "always build on this app's own server" is said.
   *
   * Only meaningful for a source Deplo BUILDS (git / upload). A compose stack has no
   * single image to move and a `docker-image` source builds nothing, so both ignore
   * it entirely.
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
   * The JavaScript framework Deplo recognised in this app's own source — a
   * {@link FrameworkId} from `lib/apps/framework-catalog.ts` ("nextjs",
   * "astro", …), or null when none was found or the build method isn't one of
   * the auto-detecting builders (Nixpacks / Railpack), the only ones this
   * applies to.
   *
   * DERIVED: every deploy re-detects and overwrites it. Typed as the id rather
   * than the definition so the stored value stays a plain string;
   * `frameworkById` resolves it to a name + default port on both sides.
   *
   * This is what Deplo READ, not necessarily what the app IS — see
   * {@link App.frameworkOverride}, which wins when set.
   */
  framework: FrameworkId | null;
  /**
   * The framework the user picked because detection got it wrong, or null (the
   * default) to trust detection. Read as `frameworkOverride ?? framework`
   * everywhere the app's framework is shown or used.
   *
   * Deliberately NOT folded into `framework`: the deploy keeps overwriting that
   * one unconditionally, so a shared column would lose the choice on the next
   * push — and the UI could no longer say "we detected Next.js" next to the
   * Vite the user chose.
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
   * Pull request previews are ON for this app. The one preview setting that
   * belongs on the App itself rather than behind `previewSettings()`: the
   * sidebar decides whether to offer the Pull requests page from it, and the
   * layout already has the row in hand. Everything else about previews stays in
   * that one read seam.
   */
  previewEnabled: boolean;
  /**
   * Cron jobs are ON for this app - same reason `previewEnabled` rides the App:
   * the sidebar decides whether to offer the Cron jobs page from it, and the
   * layout already has the row in hand. Everything else about cron jobs lives in
   * `lib/data/crons.ts`.
   */
  cronEnabled: boolean;
  /**
   * Whether this app's deploy hook — the URL that triggers a production deploy
   * from outside the dashboard — answers at all. On by default; the endpoint is
   * bearer-gated regardless (see `lib/data/deploy-hook.ts`), so this is the kill
   * switch, not the lock. The hook's secret URL segment is deliberately NOT part
   * of this type: it is decrypted only by that module, behind its own gate.
   */
  deployHookEnabled: boolean;
  /**
   * Extra flags this app appends to the `docker compose up` that brings it up,
   * as the operator typed them (`"--pull always --scale web=3"`), or null for
   * the untouched command — which is every app that never opened the setting.
   *
   * Additive, never a replacement: deplo keeps choosing the project name, the
   * stack file and the env-file, and the flags that would change them are
   * refused. See {@link lib/deploy/compose-args.ts}.
   */
  composeUpArgs: string | null;
  /**
   * How many previous deployments this app can be rolled back to (default 3).
   *
   * A retention number, not a toggle: it is what keeps that many of this app's
   * built images alive on its server, so `0` means there is nothing to go back to
   * and the Rollback action disappears. Only a source Deplo builds accrues
   * rollbacks - a compose stack has no single image to re-run.
   */
  rollbackKeep: number;
  /**
   * Per-app resource caps applied at deploy time, or `null` when the app has no
   * limits set (the default). See {@link ResourceLimits}.
   */
  resources: ResourceLimits | null;
  latestDeploymentId: ID | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * How many previous deployments a new app can be rolled back to.
 *
 * Three, not zero: the feature exists so that a bad deploy is undoable, and a
 * default of zero would mean every app only becomes undoable once someone has
 * found the setting - which is the same as not shipping it. It costs three extra
 * images per app on the host, which is the honest price of being able to go back.
 */
export const DEFAULT_ROLLBACK_KEEP = 3;

/** The ceiling on {@link App.rollbackKeep}. Retention is disk: past this, an app
 *  is hoarding gigabytes of images nobody will ever roll back to. `0` is the
 *  floor and means "keep nothing to go back to". */
export const MAX_ROLLBACK_KEEP = 20;

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
  /**
   * The host-side KEY this deploy owns: the container `deplo-<key>`, the stack
   * file `<key>.yml`, the files dir `files/<key>`, the named volumes
   * `deplo-<key>-<name>` and every agent RPC. For production it IS the app slug;
   * for a pull request preview it is `<slug>__pr-<n>`. See
   * {@link ../deploy/deploy-key}.
   */
  deployKey: string;
  /** The pull request preview this deploy belongs to, or null for production. */
  previewId: ID | null;
  /** Denormalized pull request number, so the deployments list can still say
   *  "PR #42" after the preview row is reaped. Null for production. */
  prNumber: number | null;
  /**
   * The server this deploy runs on. Denormalized so the queue can drain
   * per-server without an apps join — and load-bearing beyond that, because a
   * pull request preview may be pinned to a different machine than production.
   * The row, never the app, is the authority on where a deploy went. Nullable
   * only for rows that predate the column; every write since sets it.
   */
  serverId: ID | null;
  /**
   * The server this deploy BUILT on, when that was not `serverId`. null is the
   * ordinary case, "built where it runs", and is also what every row that predates
   * build servers holds. Denormalized and FK-less like `serverId`: the queue drains
   * on it (the builder's lane is the one that matters, because the build is the
   * cost), and it is the audit answer to where this app's source and secrets went -
   * which must not vanish when someone decommissions a builder.
   */
  buildServerId: ID | null;
  commitSha: string;
  commitMessage: string;
  commitAuthor: string;
  branch: string;
  url: string;
  createdAt: string;
  /** When the build was claimed off the queue and actually started running —
   *  the origin `buildDurationMs` is measured from, and what the UI ticks the
   *  live "Build time" from. Null while queued (nothing has started yet). */
  startedAt: string | null;
  readyAt: string | null;
  buildDurationMs: number | null;
  /**
   * Replace the running containers even if the rendered stack is unchanged
   * (`compose up --force-recreate`). Set only by "Rebuild container" — every
   * other deploy leaves it false, so an unchanged reroute still causes no
   * restart.
   */
  forceRecreate: boolean;
  /**
   * The image tag this deploy rendered into its stack and the agent ran. Set only
   * where Deplo BUILT it (git, upload) - `deplo/<deployKey>:<id[0:12]}`, living on
   * the owning server. Null for a compose stack (no single image) and for a
   * prebuilt `docker-image` source (a mutable registry tag, nothing pinned), so a
   * non-null value is exactly "there is an image of ours to go back to".
   */
  imageRef: string | null;
  /** Set when this deploy is a ROLLBACK: the deployment whose image it re-ran.
   *  Null ⇒ this deploy built its own image (which is also what decides whether it
   *  occupies a retention slot - a rollback reuses an image, it does not add one). */
  rollbackOf: ID | null;
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
 *  - cloudflare   Cloudflare fronts the domain: it terminates TLS at its edge and
 *                 presents the public certificate, so the origin is served over
 *                 HTTPS (`websecure`) with a DNS-01 resolver named `cloudflare`
 *                 when the proxy defines one. Chosen AUTOMATICALLY the moment the
 *                 DNS check finds a cert-less domain proxied (status
 *                 `cloudflare`) — see `certProviderForDns` — and freely
 *                 changeable afterwards, like any other domain setting.
 *  - custom       a certificate the operator installed on the owning SERVER
 *                 themselves (Settings → Servers → Certificates). The router is
 *                 served over HTTPS on `websecure` with NO `certresolver` label,
 *                 so Traefik presents the certificate from its own store and
 *                 never asks an ACME provider for one. Nothing here checks that
 *                 a certificate covering this hostname is actually installed —
 *                 the domains a certificate covers live on the host, not in the
 *                 control plane.
 *  - none         no certificate — serve plain HTTP on the `web` entrypoint, no
 *                 TLS labels, no forced upgrade. The default for every NEW
 *                 domain (stored explicitly): a cert is only registered when
 *                 the user — or a template that expects HTTPS, or the Cloudflare
 *                 detection above — opts in.
 * Absent ⇒ `letsencrypt` (back-compat with domains created before this field).
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
   * it serves the app. Set only by the `www` ⇄ non-`www` pairing, and only ever
   * to another hostname of the SAME app that serves — never a chain, never an
   * outside address. Its router still targets this domain's port/service (a
   * Traefik router needs a service) but the generated `redirectregex` middleware
   * answers first, so the container is never reached.
   */
  redirectTo: string | null;
  ssl: boolean;
  /**
   * "auto"  the zero-config nip.io hostname Deplo generates once per project
   * (already routed, no DNS setup). "custom"  a domain the user added and must
   * point at this server. "redirect"  the `www`/non-`www` companion Deplo
   * generated for a domain that asked to be paired — the provenance that makes
   * un-pairing safe to DELETE the row, where a hostname the user typed is only
   * un-redirected. Defaults to "custom" when absent.
   */
  source?: "auto" | "custom" | "redirect";
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
  /** AES-GCM-encrypted password. Reversible (re-hashed to htpasswd at render);
   * never in a DTO, read back only through the gated reveal. */
  passwordEnc: string;
  /** Who added the credential / who last rotated its password. Null for rows
   * written before migration 0045, or once that user is deleted. Identity
   * metadata, never a value — see {@link VarAuthor}. */
  createdByUserId: ID | null;
  updatedByUserId: ID | null;
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
  /**
   * DISPLAY name, editable in Settings → General. It is NOT the container's
   * identity — {@link host} is (the compose project, its volume and its DNS name
   * on the `deplo` network), and that is frozen at creation, so a rename is a
   * pure label change that never touches the running stack. Unique per team.
   */
  name: string;
  /**
   * Uploaded display logo — a base64 image data-URI, or null to fall back to the
   * engine's real brand mark (`DB_LOGOS`). Same contract as an App's logo:
   * cosmetic only, never read by a deploy, validated by `isValidLogoValue`.
   */
  logo: string | null;
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
  /** Cron jobs are ON for this database - the same opt-in switch, and the same
   *  reason it rides the DTO, as `apps.cronEnabled`: the sidebar decides whether
   *  to offer the Cron jobs page from it. */
  cronEnabled: boolean;
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

export type DestinationStatus = "connected" | "error" | "unverified";

/**
 * Where backup artifacts are kept. Two kinds, because demanding an S3 bucket
 * before anyone can take a first backup asks the user to stand up infrastructure
 * they may not have as a precondition for the most basic safety feature.
 *
 *  - `s3`     — an S3-compatible bucket.
 *  - `server` — a directory on a server in the fleet: the same VPS the workload
 *               runs on, or another one (including a storage-only box).
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
   * private network is reachable at all. Instance-admin only to set — the agent
   * dials this address as root — and false for everything created from the
   * ordinary form.
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
   * The age keypair the artifacts are encrypted to. The RECIPIENT is public and
   * is all the agent gets when writing, so a storage host produces artifacts it
   * cannot itself read. The IDENTITY is the private half and leaves the control
   * plane only for a restore or a download.
   *
   * Set for BOTH kinds. A bucket artifact is encrypted too: a project archive
   * carries the app's whole decrypted env, so leaving that one destination shape
   * in the clear undid deplo's own write-only-secrets model. Null only on an
   * `s3` destination created before that, whose existing objects are plaintext.
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
   * `unverified` badge); a non-null `lastTestAt` with an empty `lastTestError`
   * ⇒ the probe passed. The error is the agent's VERBATIM message, kept so the
   * card can say why a destination is red and the connection log can be read
   * after the fact without re-dialing the destination.
   */
  lastTestAt: string | null;
  lastTestError: string | null;
  /** Server whose agent served the probe (null ⇒ never tested, or removed since). */
  lastTestServerId: ID | null;
  /** Probe duration in ms (null ⇒ never tested). */
  lastTestMs: number | null;
  /**
   * Server destinations only: the headroom and the resolved root the last check
   * saw. Information for the operator, never a pre-flight gate — a dump's size
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
  /**
   * The target's id as plain text, carried alongside `databaseId`/`appId`
   * because those two are `ON DELETE SET NULL`: deleting the app or database
   * blanked the only thing that named what an artifact belonged to, and its
   * bytes then sat on the destination with nothing left that could find them.
   */
  targetId: ID;
  /** Object key: `deplo/<teamId>/<kind>/<targetId>/<ISO-timestamp>.<ext>`. */
  objectKey: string;
  sizeBytes: number;
  /**
   * How big the artifact is once decrypted: the exact number of bytes a download
   * delivers, and so its Content-Length. Not derivable from `sizeBytes` (age
   * adds a header plus a tag per 64 KiB chunk), so only the agent that wrote the
   * artifact ever saw it. Null for a run taken before it was recorded, and the
   * download then sends no length at all rather than a wrong one.
   */
  decryptedSizeBytes: number | null;
  /**
   * Hex sha256 of the artifact as written (ciphertext, before decryption) —
   * what a restore checks before feeding those bytes to anything. Null for a run
   * taken before integrity checking shipped, and a restore says so out loud
   * rather than quietly skipping the check.
   */
  sha256: string | null;
  /**
   * When the orphan sweep first saw this run's target gone. The keep window for
   * a deleted target's artifacts runs from HERE, not from `startedAt` - an app
   * deleted today may well have month-old backups, and "keep them" has to mean
   * something.
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
 * How a cron run ended. Six values, and the distinctions all earn their keep:
 *
 *  - `timedout` is apart from `failed` because it points at a SETTING (the job's
 *    timeout) rather than at the command.
 *  - `skipped` never started at all - the container was stopped, or a previous
 *    run was still going. It is not a failure and raises no alert.
 *  - `lost` means Deplo could not find out how it ended, because the agent
 *    restarted while the command was in flight. It is deliberately not `failed`:
 *    the command runs inside the AGENT's process, so a control-plane restart does
 *    not kill it, and a run we lost track of most likely succeeded.
 */
export type CronRunStatus =
  | "running"
  | "succeeded"
  | "failed"
  | "timedout"
  | "skipped"
  | "lost";

/**
 * A scheduled command inside one container of an App or a Database.
 *
 * Stored metadata only; running it produces a {@link CronRun}. The `timezone` is
 * per job and NOT UTC - unlike a {@link Backup}, whose "some time overnight" gets
 * away with a single zone (see ADR-0018).
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
 * One scheduled fire of a {@link CronJob}, retries included.
 *
 * `attempt` counts launches for THIS fire, so one scheduled minute is always one
 * row and the stored output is the LAST attempt's. `command` and the limits are
 * frozen at insert: editing a job mid-flight must not change the deadline the
 * reaper enforces, and the history must say what actually ran.
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
  | "member"
  | "backup"
  | "s3"
  /** Cron jobs: a job created, edited, run or deleted. */
  | "cron"
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
 * A plugin a team installed from a plugin repository (ADR-0005). An installed
 * plugin is a host-managed container — NOT an App — so this row is deliberately
 * minimal: no `status`, `url`, `appId`, or token reference. Status is read
 * live from the container at query time; the URL is computed from the stored
 * `slug`.
 *
 * **DORMANT (ADR-0013):** the Plugins feature is deferred and nothing writes this
 * row today — the boot sweep in `lib/plugins/retire.ts` clears any left by an
 * older version. The table and this type stay so the feature returns without a
 * migration.
 *
 * The `slug` is the FROZEN physical identity of the container — its name,
 * compose project, stack file, and Traefik path router all key off it. It is
 * computed once at install (`pluginSlug(catalogId, teamSlug)`) and persisted, so a
 * later team rename never orphans the running container/router — exactly as an
 * app's slug is frozen and `renameApp` never touches it.
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
 * Where a team's alerts are delivered.
 *
 * A team configures N of them and any kind may repeat: EACH instance carries its
 * own alert selection, because a team room that wants every deploy outcome and
 * an on-call phone that wants only the failures are the normal case, not the
 * exotic one. See `NotificationChannelInstance`.
 *
 * The union is derived from the array so there is ONE declaration — the GraphQL
 * enum reads the same array, and the two cannot drift.
 * Everything after `telegram` is beta.
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
 * description and default in `lib/alerts.ts`.
 *
 * Every key here MUST have a real emitter. A key nobody dispatches is exactly
 * the bug this feature was built to fix: a switch that promises an alert and
 * delivers silence.
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
 * Canonical order of every alert — the order the picker lists them in and the
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
 * ONE configured destination. A team has N of them, and any kind may repeat —
 * two Discord rooms with different alert sets is the normal case, not the
 * exotic one.
 *
 * Flat, mirroring its row: `url`/`target`/`secret*` are the shared concepts
 * (see `notification_channels`), and only the fields this `kind` uses carry
 * meaning — the UI decides which to show. Credentials surface as BITS and have
 * no read path, by design.
 */
export interface NotificationChannelInstance {
  id: ID;
  kind: NotificationChannel;
  /** The team's own label, or "" — the UI falls back to the kind's own name. */
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
 * the user actually retyped. They ride in their own bag so a masked `…Set` bit
 * can never be mistaken for a value. **An absent or empty secret means "keep the
 * stored one"** — an edit that only moves the SMTP host must not require
 * retyping the password, and there is no reveal path to fill it back in.
 */
export interface NotificationChannelInput
  extends Omit<NotificationChannelInstance, "id" | "secretSet" | "secret2Set"> {
  secrets?: { secret?: string; secret2?: string };
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

/**
 * Which non-GitHub git host a {@link GitConnection} talks to. GitHub is absent on
 * purpose: it authenticates through a GitHub App, not a stored token, and keeps
 * its own tables and its own UI.
 *
 * `git` is the escape hatch — any git server with no API worth calling. It
 * carries credentials and nothing else: no repository listing, no branch listing,
 * no webhook registration.
 */
export type GitProviderId = "gitlab" | "bitbucket" | "gitea" | "git";

/**
 * A team's credentials for one git host, created once in Settings → Git and
 * reused by every App deploying from that host — the counterpart of a
 * {@link GithubInstallation}.
 *
 * The token itself is NEVER in this DTO (no `tokenEnc` field, no reveal path): it
 * is decrypted only at the clone edge and when calling the provider's API.
 * `health` is re-derived by the maintenance sweep and by "Test connection", so a
 * revoked token surfaces before the next deploy fails on it.
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
   * Surfaced rather than kept internal for the same reason a backup
   * destination's encryption state is: a connection whose reach nobody can see
   * is one nobody audits.
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
