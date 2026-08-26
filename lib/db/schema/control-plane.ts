import {
  pgTable,
  pgEnum,
  text,
  integer,
  bigint,
  boolean,
  primaryKey,
  uniqueIndex,
  index,
  check,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { isoTimestamptz } from "./columns";

/**
 * Relational control-plane schema - the full normalization of the single JSONB
 * `deplo_state` document (relational-store PLAN §1, §2).
 */

/* ------------------------------------------------------------------ */
/* pgEnums - only the closed, coerce-at-backfill value sets            */
/* ------------------------------------------------------------------ */

/** [LogLevel](../../types.ts) - closed; verbose builds only ever emit these. */
export const deploymentLogLevel = pgEnum("deployment_log_level", [
  "info",
  "warn",
  "error",
  "debug",
  "command",
  "success",
]);

/** [GithubInstallation.accountType](../../types.ts) - GitHub's two account kinds. */
export const githubAccountType = pgEnum("github_account_type", [
  "User",
  "Organization",
]);

/* ================================================================== */
/* Identity aggregate                                                  */
/* ================================================================== */

/**
 * [User](../../types.ts).
 */
export const users = pgTable(
  "users",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    username: text("username").notNull(),
    name: text("name").notNull(),
    role: text("role").notNull(),
    isInstanceAdmin: boolean("is_instance_admin").notNull().default(false),
    suspended: boolean("suspended").notNull().default(false),
    canExposePorts: boolean("can_expose_ports").notNull().default(false),
    canMountHostVolumes: boolean("can_mount_host_volumes")
      .notNull()
      .default(false),
    avatarColor: text("avatar_color").notNull(),
    // DEAD since 0055: sessions are Better Auth rows now, so revoking them is a
    // DELETE, not a version bump. The column survives one release so a rollback
    // still finds the schema it expects; dropping it is its own migration.
    tokenVersion: integer("token_version").notNull().default(0),
    /** True when the account has a verified TOTP factor. Written ONLY by Better
     *  Auth's twoFactor plugin; read by deplo's policy gate (lib/membership.ts). */
    twoFactorEnabled: boolean("two_factor_enabled").notNull().default(false),
    // Better Auth's `user` model requires these three. deplo has no email verification
    // flow, so `email_verified` is true for everyone; `updated_at` exists to satisfy
    // the model.
    emailVerified: boolean("email_verified").notNull().default(true),
    image: text("image"),
    updatedAt: isoTimestamptz("updated_at")
      .notNull()
      .default(sql`now()`),
    createdAt: isoTimestamptz("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("users_email_lower_uq").on(sql`lower(${t.email})`),
    uniqueIndex("users_username_uq").on(t.username),
  ],
);

/**
 * [Team](../../types.ts).
 */
export const teams = pgTable(
  "teams",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    plan: text("plan").notNull(),
    // The team's ABSOLUTE owner - the user who originally created the team (the
    // "crown").
    founderUserId: text("founder_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    // Team-wide 2FA policy: when true, a member without a verified TOTP factor resolves
    // NO capabilities in this team, over the UI and the bearer API alike
    // (lib/membership.ts).
    requireTwoFactor: boolean("require_two_factor").notNull().default(false),
    // Whether this team's API tokens may drive it over MCP (`/api/mcp`). Off ⇒ the
    // endpoint refuses the whole request, before any tool runs.
    mcpEnabled: boolean("mcp_enabled").notNull().default(false),
    // When the team's default backup destination was seeded (lib/data/destinations.ts
    // `ensureDefaultDestination`).
    backupDefaultSeededAt: isoTimestamptz("backup_default_seeded_at"),
    // The team's picture, shown before its name everywhere the team is named.
    image: text("image"),
    createdAt: isoTimestamptz("created_at").notNull(),
  },
  (t) => [uniqueIndex("teams_slug_uq").on(t.slug)],
);

/**
 * [Folder](../../types.ts). Ownership is NOT cleared when the owner merely leaves
 * the team (the user row still exists); the DB only guarantees the FK never
 * dangles.
 */
export const folders = pgTable(
  "folders",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    parentId: text("parent_id").references((): AnyPgColumn => folders.id, {
      onDelete: "set null",
    }),
    color: text("color"),
    ownerUserId: text("owner_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    // The Project CONTAINER this folder lives in, or NULL when the folder sits at the
    // team top level (additive adoption - ADR-0008). Forward-ref thunk because
    // `projects` (the container) is declared just below.
    projectId: text("project_id").references((): AnyPgColumn => projects.id, {
      onDelete: "set null",
    }),
    createdAt: isoTimestamptz("created_at").notNull(),
    updatedAt: isoTimestamptz("updated_at").notNull(),
  },
  (t) => [
    index("folders_owner_idx").on(t.ownerUserId),
    index("folders_project_idx").on(t.projectId),
  ],
);

/**
 * [Project](../../types.ts) - the top-level, team-scoped CONTAINER introduced in
 * ADR-0008 (folder-like, but it owns Environments). It has NO `parent_id` - a
 * Project never nests in a Project.
 */
export const projects = pgTable(
  "projects",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    color: text("color"),
    ownerUserId: text("owner_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    // The migration still creating this project. See the apps column.
    migrationRunId: text("migration_run_id"),
    createdAt: isoTimestamptz("created_at").notNull(),
    updatedAt: isoTimestamptz("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("projects_team_slug_uq").on(t.teamId, t.slug),
    index("projects_owner_idx").on(t.ownerUserId),
  ],
);

/**
 * Per-Project-container access grants - the direct clone of `folder_grants` for
 * the new Project container. One row per (project, user, capability); the OWNER
 * is derived from `projects.owner_user_id`, not stored here. Both FKs CASCADE.
 */
export const projectGrants = pgTable(
  "project_grants",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    capability: text("capability").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.userId, t.capability] }),
    index("project_grants_user_idx").on(t.userId),
  ],
);

/**
 * [Environment](../../types.ts) - a per-Project, first-class ISOLATED deploy
 * target (ADR-0008 Phase 3).
 */
export const environments = pgTable(
  "environments",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    kind: text("kind").notNull(),
    gitBranch: text("git_branch").notNull().default(""),
    isDefault: boolean("is_default").notNull().default(false),
    position: integer("position").notNull(),
    // The migration still creating this environment. See the apps column.
    migrationRunId: text("migration_run_id"),
    createdAt: isoTimestamptz("created_at").notNull(),
    updatedAt: isoTimestamptz("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("environments_project_name_uq").on(t.projectId, t.name),
    uniqueIndex("environments_project_slug_uq").on(t.projectId, t.slug),
    index("environments_project_idx").on(t.projectId),
  ],
);

/**
 * Per-(App, Environment) RUNTIME state (ADR-0008 Phase 3b) - the join that lets a
 * service's status / URL / latest deployment fan out along the environment axis
 * without duplicating the whole App row.
 */
export const appEnvironments = pgTable(
  "app_environments",
  {
    appId: text("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    environmentId: text("environment_id")
      .notNull()
      .references(() => environments.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("idle"),
    url: text("url"),
    latestDeploymentId: text("latest_deployment_id").references(
      (): AnyPgColumn => deployments.id,
      { onDelete: "set null" },
    ),
    createdAt: isoTimestamptz("created_at").notNull(),
    updatedAt: isoTimestamptz("updated_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.appId, t.environmentId] }),
    index("app_environments_environment_idx").on(t.environmentId),
  ],
);

/**
 * Per-folder access grants - the capabilities the folder OWNER hands to OTHER
 * users so they can see/use a folder that is otherwise private to the owner.
 */
export const folderGrants = pgTable(
  "folder_grants",
  {
    folderId: text("folder_id")
      .notNull()
      .references(() => folders.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    capability: text("capability").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.folderId, t.userId, t.capability] }),
    index("folder_grants_user_idx").on(t.userId),
  ],
);

/**
 * Per-App access grants - the third and most specific rung of the same ladder as
 * `folder_grants` / `project_grants`: one row per (app, user, capability).
 */
export const appGrants = pgTable(
  "app_grants",
  {
    appId: text("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    capability: text("capability").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.appId, t.userId, t.capability] }),
    index("app_grants_user_idx").on(t.userId),
  ],
);

/**
 * The ENVIRONMENT rung of the same ladder.
 */
export const environmentGrants = pgTable(
  "environment_grants",
  {
    environmentId: text("environment_id")
      .notNull()
      .references(() => environments.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    capability: text("capability").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.environmentId, t.userId, t.capability] }),
    index("environment_grants_user_idx").on(t.userId),
  ],
);

/**
 * A named, per-team capability set a member can be assigned - the team's Roles
 * (Settings → Team → Roles).
 */
export const teamRoles = pgTable(
  "team_roles",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    // 'owner' | 'member' | 'viewer' for the three defaults (revertible to their
    // preset, never deletable), NULL for a team-authored custom role.
    builtinKey: text("builtin_key"),
    name: text("name").notNull(),
    description: text("description"),
    // Policy, NOT a capability: capabilities are a closed set of 8 that answer "may
    // they do X", while this answers "under what condition does any of it count".
    requireTwoFactor: boolean("require_two_factor").notNull().default(false),
    // The INTENT to reach only part of the team, stored apart from the junctions below
    // for the reason `api_tokens.scoped` exists: deleting a project in the scope
    // cascades its row away, and an emptied scope with no flag would read as "no scope"
    // and silently WIDEN the role to everything.
    scoped: boolean("scoped").notNull().default(false),
    createdAt: isoTimestamptz("created_at").notNull(),
  },
  (t) => [
    // One row per built-in per team; custom roles (NULL) escape the predicate.
    uniqueIndex("team_roles_builtin_uq")
      .on(t.teamId, t.builtinKey)
      .where(sql`${t.builtinKey} is not null`),
    uniqueIndex("team_roles_name_uq").on(t.teamId, sql`lower(${t.name})`),
  ],
);

/**
 * What a scoped role REACHES: whole projects, whole folders (subtree included,
 * expanded at resolve time), or single apps.
 */
export const teamRoleScopeProjects = pgTable(
  "team_role_scope_projects",
  {
    roleId: text("role_id")
      .notNull()
      .references(() => teamRoles.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.roleId, t.projectId] }),
    index("team_role_scope_projects_project_idx").on(t.projectId),
  ],
);

export const teamRoleScopeFolders = pgTable(
  "team_role_scope_folders",
  {
    roleId: text("role_id")
      .notNull()
      .references(() => teamRoles.id, { onDelete: "cascade" }),
    folderId: text("folder_id")
      .notNull()
      .references(() => folders.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.roleId, t.folderId] }),
    index("team_role_scope_folders_folder_idx").on(t.folderId),
  ],
);

export const teamRoleScopeEnvironments = pgTable(
  "team_role_scope_environments",
  {
    roleId: text("role_id")
      .notNull()
      .references(() => teamRoles.id, { onDelete: "cascade" }),
    environmentId: text("environment_id")
      .notNull()
      .references(() => environments.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.roleId, t.environmentId] }),
    index("team_role_scope_environments_environment_idx").on(t.environmentId),
  ],
);

export const teamRoleScopeApps = pgTable(
  "team_role_scope_apps",
  {
    roleId: text("role_id")
      .notNull()
      .references(() => teamRoles.id, { onDelete: "cascade" }),
    appId: text("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.roleId, t.appId] }),
    index("team_role_scope_apps_app_idx").on(t.appId),
  ],
);

/** [teamRoles.capabilities] → junction. PK on both columns. */
export const teamRoleCapabilities = pgTable(
  "team_role_capabilities",
  {
    roleId: text("role_id")
      .notNull()
      .references(() => teamRoles.id, { onDelete: "cascade" }),
    capability: text("capability").notNull(),
  },
  (t) => [primaryKey({ columns: [t.roleId, t.capability] })],
);

/**
 * [Membership](../../types.ts). `UNIQUE(user_id, team_id)` closes the double-add
 * race. `capabilities` moved to the `membership_capabilities` junction.
 */
export const memberships = pgTable(
  "memberships",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    // The member's RANK: 'owner' outranks everyone (only an owner may act on another
    // owner or hand out the owner role).
    role: text("role").notNull(),
    // The assigned {@link teamRoles} row. `ON DELETE RESTRICT`: a role with members
    // can't be deleted out from under them (the data layer refuses first, with a
    // message naming the count).
    roleId: text("role_id").references(() => teamRoles.id, {
      onDelete: "restrict",
    }),
    // Whether this member's access is set per NODE on top of the role - the admin's
    // MODE choice, not a derived fact. Kept as a column because node rows cascade away:
    // "granular with nothing left ticked" must not read as Role mode.
    granular: boolean("granular").notNull().default(false),
    // This member's capability set is THEIR OWN: the member page saved something other
    // than what their role grants, so `syncMembersOfRole` leaves them alone.
    customCapabilities: boolean("custom_capabilities").notNull().default(false),
    // THIS PERSON's arrangement of the topbar team switcher - their own preference, not
    // a team-wide one, which is why it sits here rather than in a `user_team_order`
    // junction: this row already IS the (user, team) junction the order is grained on,
    // the same shape `team_app_order.position` has.
    switcherPosition: integer("switcher_position"),
    createdAt: isoTimestamptz("created_at").notNull(),
  },
  (t) => [uniqueIndex("memberships_user_team_uq").on(t.userId, t.teamId)],
);

/**
 * [Membership.capabilities](../../types.ts) → junction. Loaded into memory and
 * `.includes()`-checked as today (run `cleanCapabilities` at backfill). PK on
 * both columns.
 */
export const membershipCapabilities = pgTable(
  "membership_capabilities",
  {
    membershipId: text("membership_id")
      .notNull()
      .references(() => memberships.id, { onDelete: "cascade" }),
    capability: text("capability").notNull(),
  },
  (t) => [primaryKey({ columns: [t.membershipId, t.capability] })],
);

/**
 * [Invite](../../types.ts). `status` is a soft lifecycle (never hard-delete on
 * revoke).
 */
export const invites = pgTable(
  "invites",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role").notNull(),
    tokenHash: text("token_hash").notNull(),
    status: text("status").notNull(),
    invitedBy: text("invited_by").notNull(),
    expiresAt: isoTimestamptz("expires_at").notNull(),
    createdAt: isoTimestamptz("created_at").notNull(),
    acceptedAt: isoTimestamptz("accepted_at"),
  },
  (t) => [
    uniqueIndex("invites_token_hash_uq").on(t.tokenHash),
    uniqueIndex("invites_team_email_pending_uq")
      .on(t.teamId, t.email)
      .where(sql`${t.status} = 'pending'`),
  ],
);

/** [Invite.capabilities](../../types.ts) → junction. */
export const inviteCapabilities = pgTable(
  "invite_capabilities",
  {
    inviteId: text("invite_id")
      .notNull()
      .references(() => invites.id, { onDelete: "cascade" }),
    capability: text("capability").notNull(),
  },
  (t) => [primaryKey({ columns: [t.inviteId, t.capability] })],
);

/**
 * [RegistrationLink](../../types.ts).
 */
export const registrationLinks = pgTable(
  "registration_links",
  {
    id: text("id").primaryKey(),
    tokenHash: text("token_hash").notNull(),
    // The same token, encrypted, so the admin can copy the link again instead of
    // minting a second one because they lost the first. NULL on links minted before
    // migration 0048 - those can only be revoked and re-minted.
    tokenEnc: text("token_enc"),
    status: text("status").notNull(),
    // How the registrant's team is decided: 'own_team' (they name + own a fresh team at
    // registration, the historical behavior) or 'existing_teams' (an admin pre-assigned
    // them to existing teams - see registration_link_teams).
    mode: text("mode").notNull().default("own_team"),
    createdBy: text("created_by").notNull(),
    usedByUsername: text("used_by_username"),
    expiresAt: isoTimestamptz("expires_at").notNull(),
    createdAt: isoTimestamptz("created_at").notNull(),
    usedAt: isoTimestamptz("used_at"),
  },
  (t) => [uniqueIndex("registration_links_token_hash_uq").on(t.tokenHash)],
);

/**
 * The teams an `existing_teams` registration link pre-assigns its registrant to,
 * one row per team with the role they'll receive.
 */
export const registrationLinkTeams = pgTable(
  "registration_link_teams",
  {
    id: text("id").primaryKey(),
    linkId: text("link_id")
      .notNull()
      .references(() => registrationLinks.id, { onDelete: "cascade" }),
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
  },
  (t) => [
    uniqueIndex("registration_link_teams_link_team_uq").on(t.linkId, t.teamId),
    index("registration_link_teams_link_idx").on(t.linkId),
  ],
);

/** [registrationLinkTeams.capabilities] → junction. Mirrors invite_capabilities. */
export const registrationLinkTeamCapabilities = pgTable(
  "registration_link_team_capabilities",
  {
    linkTeamId: text("link_team_id")
      .notNull()
      .references(() => registrationLinkTeams.id, { onDelete: "cascade" }),
    capability: text("capability").notNull(),
  },
  (t) => [primaryKey({ columns: [t.linkTeamId, t.capability] })],
);

/* ================================================================== */
/* Infra aggregate                                                     */
/* ================================================================== */

/**
 * [Server](../../types.ts) + the nested [ServerAgent](../../types.ts) /
 * [ServerBootstrap](../../types.ts) flattened onto the row so
 * `agent_cert_fingerprint` and `bootstrap_token_hash` are directly indexable for
 * the two lookup paths (dial by fingerprint / call-home by token) (PLAN §2
 * `servers`).
 */
export const servers = pgTable(
  "servers",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    host: text("host").notNull(),
    type: text("type").notNull(),
    status: text("status").notNull(),
    ip: text("ip").notNull(),
    dockerVersion: text("docker_version").notNull(),
    traefikEnabled: boolean("traefik_enabled").notNull(),
    cpuCores: integer("cpu_cores").notNull(),
    memoryMb: integer("memory_mb").notNull(),
    diskGb: integer("disk_gb").notNull(),
    cpuUsage: integer("cpu_usage").notNull(),
    memoryUsage: integer("memory_usage").notNull(),
    diskUsage: integer("disk_usage").notNull(),
    // Flattened ServerAgent (present once provisioned; NULL while provisioning).
    agentPort: integer("agent_port"),
    agentCertFingerprint: text("agent_cert_fingerprint"),
    agentCertPem: text("agent_cert_pem"),
    agentVersion: text("agent_version"),
    // Flattened ServerBootstrap (present only while provisioning).
    bootstrapTokenHash: text("bootstrap_token_hash"),
    bootstrapExpiresAt: isoTimestamptz("bootstrap_expires_at"),
    bootstrapUsedAt: isoTimestamptz("bootstrap_used_at"),
    lastSeenAt: isoTimestamptz("last_seen_at"),
    // When `status` was last OBSERVED (a probe classified and recorded a result), and
    // the curated reason behind a non-online value.
    statusCheckedAt: isoTimestamptz("status_checked_at"),
    // The throttle LEASE - when a probe was last claimed, advanced whether or not it
    // went on to observe anything. Kept separate from status_checked_at so an
    // inconclusive probe (timeout/skip) never fabricates a fresh observation timestamp.
    statusProbedAt: isoTimestamptz("status_probed_at"),
    statusMessage: text("status_message"),
    // Team access scope. `true` (default) = available to every team - the
    // historical instance-wide behaviour. `false` restricts the server to the
    // teams enumerated in `server_teams`. See [Server.allTeams](../../types.ts).
    allTeams: boolean("all_teams").notNull().default(true),
    // A VPS bought purely to HOLD BACKUPS: the agent is installed, Docker is not, and
    // nothing is ever deployed here.
    storageOnly: boolean("storage_only").notNull().default(false),
    // A server bought purely to COMPILE: Docker is installed, Traefik is not, and no
    // app of any team runs here.
    buildOnly: boolean("build_only").notNull().default(false),
    // A server registered ONLY to import from another platform: Docker is there (it is
    // that platform's host), Traefik is not, the shared `deplo` network is not, and
    // nothing of ours ever runs here.
    importOnly: boolean("import_only").notNull().default(false),
    // The pending removal of a MIGRATION SOURCE's agent, kept on the row that has to
    // die rather than in a queue of its own: the surviving `servers` row IS the
    // unfinished intent, and deleting it (which is what success means) drops the intent
    // with it (migration 0118).
    uninstallNextAt: isoTimestamptz("uninstall_next_at"),
    uninstallAttempts: integer("uninstall_attempts").notNull().default(0),
    uninstallError: text("uninstall_error").notNull().default(""),
    uninstallRunId: text("uninstall_run_id"),
    // This host's CPU architecture ("amd64" | "arm64"), observed from each Hello like
    // `docker_version` and `traefik_enabled` - never asserted at registration.
    hostArch: text("host_arch").notNull().default(""),
    // How many deployments this server's agent runs at once. The deploy queue
    // (lib/deploy/deploy-queue.ts) reads it as the per-server slot count; a
    // same-service deploy never overlaps regardless.
    deployConcurrency: integer("deploy_concurrency").notNull().default(1),
    // The Traefik web panel: Traefik's own dashboard, published on a domain.
    traefikDashboardDomain: text("traefik_dashboard_domain"),
    traefikDashboardUser: text("traefik_dashboard_user"),
    // Encrypted (AES-256-GCM via DEPLO_SECRET), never projected into a DTO and with no
    // reveal path.
    traefikDashboardPasswordEnc: text("traefik_dashboard_password_enc"),
    createdAt: isoTimestamptz("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("servers_cert_fingerprint_uq")
      .on(t.agentCertFingerprint)
      .where(
        sql`${t.agentCertFingerprint} is not null and ${t.agentCertFingerprint} <> ''`,
      ),
    index("servers_bootstrap_token_idx")
      .on(t.bootstrapTokenHash)
      .where(sql`${t.bootstrapTokenHash} is not null`),
  ],
);

/**
 * Server → team access junction. Rows here matter ONLY when the server's
 * `all_teams` is `false`: each row grants ONE team the right to target the server
 * for its apps/databases. PK on both columns closes the double-grant race.
 */
export const serverTeams = pgTable(
  "server_teams",
  {
    serverId: text("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.serverId, t.teamId] })],
);

/* ================================================================== */
/* Projects aggregate                                                  */
/* ================================================================== */

/**
 * [App](../../types.ts) - flat scalar columns only.
 */
export const apps = pgTable(
  "apps",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    folderId: text("folder_id").references(() => folders.id, {
      onDelete: "set null",
    }),
    // The Project this service belongs to, or NULL at the team top level
    // (additive - ADR-0008). `ON DELETE SET NULL`: deleting a project orphans
    // its apps to the top level.
    projectId: text("project_id").references(() => projects.id, {
      onDelete: "set null",
    }),
    // The Environment (of `project_id`'s Project) this service LIVES in - the
    // membership axis of the advanced-folder model (ADR-0009): each environment of a
    // project holds its OWN apps, like a sub-folder.
    environmentId: text("environment_id").references(() => environments.id, {
      onDelete: "set null",
    }),
    serverId: text("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "restrict" }),
    // Set on a server MOVE when the OLD server still holds the service's data (a
    // running stack): it names the source host the NEXT successful deploy on the new
    // server must copy the data volumes + files dir FROM (host-to-host, via the agent
    // ExportVolume/ImportVolume + ExportFiles/ImportFiles RPCs).
    migrateFromServerId: text("migrate_from_server_id").references(
      () => servers.id,
      { onDelete: "set null" },
    ),
    // Why this app's data did NOT arrive, when a migration tried to copy it and could
    // not (empty in the common case, which is every app that was never migrated).
    dataCopyError: text("data_copy_error").notNull().default(""),
    // The migration that is creating this row, while it is still running (migration
    // 0119).
    migrationRunId: text("migration_run_id"),
    // Which server BUILDS this app's image, when that is not the one that runs it. `SET
    // NULL`, not RESTRICT: removing a build server must never be blocked by an app that
    // merely preferred it, and falling back to Automatic is always valid.
    buildServerId: text("build_server_id").references(() => servers.id, {
      onDelete: "set null",
    }),
    // When the build server is unreachable, build on this app's own server instead and
    // say so in the deploy log.
    buildFallbackLocal: boolean("build_fallback_local").notNull().default(true),
    logo: text("logo"),
    // The JavaScript framework Deplo recognised in this app's own source ("nextjs",
    // "astro", …; see lib/apps/framework-catalog.ts), or NULL when none was found / the
    // build method isn't one of the auto-detecting builders.
    framework: text("framework"),
    // The framework the USER picked when detection got it wrong (same id space).
    frameworkOverride: text("framework_override"),
    source: text("source").notNull(),
    // Flattened GitRepo (NULL columns when there is no repo).
    repoProvider: text("repo_provider"),
    repoUrl: text("repo_url"),
    repoRepo: text("repo_repo"),
    repoBranch: text("repo_branch"),
    repoInstallationId: text("repo_installation_id"),
    // The `git_connections` row that authenticates this clone, for any host that is NOT
    // GitHub.
    repoConnectionId: text("repo_connection_id"),
    // Git deploy options (also flattened GitRepo fields; defaults when no repo). Read
    // by the GitHub webhook to gate a delivery.
    repoTriggerType: text("repo_trigger_type"),
    // `repo_watch_paths` - newline-separated path globs; an auto-deploy only fires
    // when a pushed commit changed a file matching one. NULL/empty ⇒ any change.
    repoWatchPaths: text("repo_watch_paths"),
    // `repo_submodules` - clone the repo's git submodules at build time.
    repoSubmodules: boolean("repo_submodules").notNull().default(false),
    dockerImage: text("docker_image"),
    // Flattened UploadArchive (NULL columns when source !== "upload").
    uploadId: text("upload_id"),
    uploadFilename: text("upload_filename"),
    uploadPath: text("upload_path"),
    uploadSize: bigint("upload_size", { mode: "number" }),
    uploadUploadedAt: isoTimestamptz("upload_uploaded_at"),
    compose: text("compose"),
    productionUrl: text("production_url"),
    status: text("status").notNull(),
    autoDeploy: boolean("auto_deploy").notNull(),
    // Deploy hook (migration 0059): the unguessable segment of this app's "deploy now"
    // URL, AES-GCM encrypted because the link has to be readable back, and NULL until
    // someone first opens the hook (minted on demand, so no app carries a live
    // credential it never asked for).
    deployHookTokenEnc: text("deploy_hook_token_enc"),
    // The hook's kill switch, ON by default (it is already bearer-gated).
    deployHookEnabled: boolean("deploy_hook_enabled").notNull().default(true),
    // Extra flags this app adds to the `docker compose up` its server runs (migration
    // 0060) - the RAW string as typed; the deploy edge splits it into argv tokens.
    composeUpArgs: text("compose_up_args"),
    // How many previous deployments this app can be rolled back to (migration 0094).
    // Defaults to 3 - the point of the feature is that a bad deploy is undoable without
    // anyone configuring anything first.
    rollbackKeep: integer("rollback_keep").notNull().default(3),
    // Per-app resource limits (flattened ResourceLimits, like repo_*/upload_*).
    resourceMemLimitMb: integer("resource_mem_limit_mb"),
    resourceMemReservationMb: integer("resource_mem_reservation_mb"),
    resourceMemSwapMb: integer("resource_mem_swap_mb"),
    resourceCpuMilli: integer("resource_cpu_milli"),
    resourceCpuShares: integer("resource_cpu_shares"),
    resourceCpuset: text("resource_cpuset"),
    resourcePidsLimit: integer("resource_pids_limit"),
    resourceShmSizeMb: integer("resource_shm_size_mb"),
    resourceStorageSizeGb: integer("resource_storage_size_gb"),
    resourceUlimitNofile: integer("resource_ulimit_nofile"),
    resourceUlimitNproc: integer("resource_ulimit_nproc"),
    resourceOomScoreAdj: integer("resource_oom_score_adj"),
    // Per-app health check (migration 0127), flattened like resource_* for the
    // same reason: a nested shape would be a JSONB column, and there are none.
    healthCheckEnabled: boolean("health_check_enabled")
      .notNull()
      .default(false),
    /** `'http'` | `'command'`. NULL only on a row that never turned it on. */
    healthCheckType: text("health_check_type"),
    healthCheckPath: text("health_check_path"),
    healthCheckPort: integer("health_check_port"),
    healthCheckCommand: text("health_check_command"),
    healthCheckIntervalS: integer("health_check_interval_s"),
    healthCheckTimeoutS: integer("health_check_timeout_s"),
    healthCheckRetries: integer("health_check_retries"),
    healthCheckStartPeriodS: integer("health_check_start_period_s"),
    // Pull request previews (one ephemeral stack per open pull request), flattened like
    // resource_*: NULL ⇒ the platform default, so an app that never opened the setting
    // behaves identically to one that did.
    previewEnabled: boolean("preview_enabled").notNull().default(false),
    // NULL ⇒ a deterministic nip.io host on plain HTTP (zero DNS configuration, and
    // nip.io can never hold a Let's Encrypt certificate - it is ONE registered domain
    // sharing one rate limit across the whole internet).
    previewBaseDomain: text("preview_base_domain"),
    // NULL ⇒ PREVIEW_MAX_ACTIVE_DEFAULT. That asymmetry is the whole design: without
    // it, three active pull requests under a cap of three would destroy each other on
    // every commit, a full build per cycle.
    previewMaxActive: integer("preview_max_active"),
    // NULL ⇒ PREVIEW_TTL_DAYS_DEFAULT. Idle days before the reaper closes a preview:
    // what makes the cap self-healing, and the safety net for a `closed` webhook that
    // never arrived.
    previewTtlDays: integer("preview_ttl_days"),
    // NULL ⇒ "approve". deny | approve | allow. A pull request from a fork is
    // attacker-authored code that would run on the operator's host, so by default it
    // lands in the list as blocked and waits for a member with `deploy`.
    previewForkPolicy: text("preview_fork_policy"),
    // Where previews run: pointing pull request builds at a scrap machine keeps
    // them off the box serving production.
    previewServerId: text("preview_server_id").references(() => servers.id, {
      onDelete: "set null",
    }),
    // HTTPS on preview hosts.
    previewHttps: boolean("preview_https").notNull().default(false),
    // Rebuild a preview when its pull request receives a new commit.
    previewAutoDeploy: boolean("preview_auto_deploy").notNull().default(true),
    // Container port a preview routes to. Minted onto `app_previews.port` at creation,
    // because the renderer reads the preview ROW, not this table.
    previewPort: integer("preview_port"),
    // Build a pull request while it is still a draft. Off by default: a draft is
    // work in progress, and a container for it burns a slot nobody asked for.
    // The manual "Deploy a pull request" action is the per-case escape hatch.
    previewBuildDrafts: boolean("preview_build_drafts")
      .notNull()
      .default(false),
    // Post (and keep updating) the one sticky comment carrying the preview URL.
    previewComment: boolean("preview_comment").notNull().default(true),
    // Newline-separated pull request LABELS that gate a preview: a pull request must
    // carry at least one to get one.
    previewRequiredLabels: text("preview_required_labels"),
    // Cron jobs (scheduled commands run inside this app's container).
    cronEnabled: boolean("cron_enabled").notNull().default(false),
    // The container console (exec + attach). Off until asked for: it is a shell
    // inside the running container.
    consoleEnabled: boolean("console_enabled").notNull().default(false),
    // Pointer to the service's latest Deployment. `SET NULL` so deleting a deployment
    // can't leave a dangling pointer (the orphan-prevention-as-DB- invariant goal).
    latestDeploymentId: text("latest_deployment_id").references(
      (): AnyPgColumn => deployments.id,
      { onDelete: "set null" },
    ),
    // Who created this app. `ON DELETE SET NULL` because the default must be the safe
    // one: removing someone's account can never, by itself, destroy an app the team
    // still runs - that call belongs to the operator ticking the box, not to a cascade.
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    // When someone confirmed this app's deletion (migration 0097).
    deletingAt: isoTimestamptz("deleting_at"),
    createdAt: isoTimestamptz("created_at").notNull(),
    updatedAt: isoTimestamptz("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("apps_slug_uq").on(t.slug),
    index("apps_team_idx").on(t.teamId),
    index("apps_folder_idx").on(t.folderId),
    index("apps_project_idx").on(t.projectId),
    index("apps_environment_idx").on(t.environmentId),
    // SET NULL on user delete would otherwise scan every app row (migration 0042
    // indexed the other SET NULL FKs for the same reason).
    index("apps_created_by_idx").on(t.createdByUserId),
  ],
);

/**
 * [BuildConfig](../../types.ts) → 1-to-1 child (was `apps.build`). `build_method`
 * plain text, NO CHECK (legacy values are coerced, never rejected).
 */
export const appBuild = pgTable("app_build", {
  appId: text("app_id")
    .primaryKey()
    .references(() => apps.id, { onDelete: "cascade" }),
  buildMethod: text("build_method").notNull(),
  rootDirectory: text("root_directory").notNull(),
  // Include files outside the root directory in the build context (default on);
  // skip an auto-deploy when a push left the root directory untouched (default
  // off). Additive booleans with defaults so existing rows keep today's behaviour.
  includeFilesOutsideRoot: boolean("include_files_outside_root")
    .notNull()
    .default(true),
  skipUnchangedDeployments: boolean("skip_unchanged_deployments")
    .notNull()
    .default(false),
  // Reuse the owning server's Docker layer cache (and the builder's own cache mounts)
  // between this app's builds - default ON, which is what makes a redeploy of an
  // unchanged app take seconds.
  buildCache: boolean("build_cache").notNull().default(true),
  // Armed by "Clear build cache": the NEXT build of this app ignores the cache, then
  // the deploy clears the flag.
  buildCacheClearPending: boolean("build_cache_clear_pending")
    .notNull()
    .default(false),
  installCommand: text("install_command").notNull(),
  buildCommand: text("build_command").notNull(),
  outputDirectory: text("output_directory").notNull(),
  startCommand: text("start_command").notNull(),
  runtimeVersion: text("runtime_version").notNull(),
  port: integer("port").notNull(),
});

/**
 * [BuildMethodSettings](../../types.ts) → 1-to-1 child (was nested
 * `methodSettings`).
 */
export const appBuildMethodSettings = pgTable("app_build_method_settings", {
  appId: text("app_id")
    .primaryKey()
    .references(() => apps.id, { onDelete: "cascade" }),
  dockerfilePath: text("dockerfile_path"),
  dockerContextPath: text("docker_context_path"),
  dockerBuildStage: text("docker_build_stage"),
  railpackVersion: text("railpack_version"),
  nixpacksPublishDirectory: text("nixpacks_publish_directory"),
  staticSinglePageApp: boolean("static_single_page_app"),
});

/**
 * [VolumeMount](../../types.ts) → ordered child.
 */
export const appVolumes = pgTable(
  "app_volumes",
  {
    appId: text("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    volumeId: text("volume_id").notNull(),
    type: text("type"),
    name: text("name").notNull(),
    // Compose-stack apps only: the compose service this volume mounts into.
    // NULL ⇒ the stack's default service (and always NULL for single-container
    // apps, which have exactly one service).
    service: text("service"),
    projectPath: text("project_path"),
    hostPath: text("host_path"),
    mountPath: text("mount_path").notNull(),
    readOnly: boolean("read_only").notNull(),
    // Host binds only: "rslave"/"rshared" ⇒ the mount follows submounts that
    // appear later. NULL is docker's rprivate default (a startup snapshot).
    propagation: text("propagation"),
  },
  (t) => [primaryKey({ columns: [t.appId, t.position] })],
);

/**
 * [App.mounts](../../types.ts) → ordered child of `{filePath, content}`
 * template config files. `content` is byte-preserved (reconciliation asserts
 * byte-equality, PLAN §2 `app_mounts` / Decision 14).
 */
export const appMounts = pgTable(
  "app_mounts",
  {
    appId: text("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    filePath: text("file_path").notNull(),
    content: text("content").notNull(),
  },
  (t) => [primaryKey({ columns: [t.appId, t.position] })],
);

/**
 * [Deployment](../../types.ts) - fully flat. `seq bigint identity` (PLAN §5) so
 * sorts are `ORDER BY created_at DESC, seq DESC`. `(project_id, created_at DESC,
 * seq DESC)` index. No `team_id` (joined via service).
 */
export const deployments = pgTable(
  "deployments",
  {
    id: text("id").primaryKey(),
    seq: bigint("seq", { mode: "number" }).generatedAlwaysAsIdentity(),
    appId: text("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    // Denormalized owning server (mirrors apps.server_id at insert time). NOT a FK - a
    // deployment is a historical record that must survive its server's deletion
    // (apps.server_id is RESTRICT, so a live service can't lose its server).
    serverId: text("server_id"),
    // The server this deploy BUILT on, when that was not `server_id`.
    buildServerId: text("build_server_id"),
    status: text("status").notNull(),
    environment: text("environment").notNull(),
    // The host-side KEY this deploy owns: the container `deplo-<key>`, the stack file
    // `<key>.yml`, the files dir `files/<key>`, the named volumes `deplo-<key>-<name>`
    // and every agent RPC.
    deployKey: text("deploy_key").notNull(),
    // The preview this deploy belongs to, or NULL for production. `SET NULL`, not
    // cascade: destroying a preview must never delete the build history of what
    // it deployed.
    previewId: text("preview_id").references(
      (): AnyPgColumn => appPreviews.id,
      {
        onDelete: "set null",
      },
    ),
    // Denormalized pull-request number so the deployments list can still say
    // "PR #42" after the preview row is gone.
    prNumber: integer("pr_number"),
    commitSha: text("commit_sha").notNull(),
    commitMessage: text("commit_message").notNull(),
    commitAuthor: text("commit_author").notNull(),
    branch: text("branch").notNull(),
    url: text("url").notNull(),
    readyAt: isoTimestamptz("ready_at"),
    // When the build actually STARTED - the moment the queue drain claimed this row
    // (`queued` → `building`), i.e. the instant `build_duration_ms` is measured from.
    startedAt: isoTimestamptz("started_at"),
    buildDurationMs: bigint("build_duration_ms", { mode: "number" }),
    // This deploy must REPLACE the running containers even when the rendered stack is
    // unchanged (`docker compose up --force-recreate`).
    forceRecreate: boolean("force_recreate").notNull().default(false),
    // The image tag this deploy actually rendered into its stack - the string the agent
    // built and `compose up` ran (migration 0094).
    imageRef: text("image_ref"),
    // Set when this deploy is a ROLLBACK: the id of the deployment whose image it
    // re-ran.
    rollbackOf: text("rollback_of"),
    creator: text("creator").notNull(),
    // WHO `creator` names, when it names somebody with a deplo account. `creator` stays
    // free text because it also carries a GitHub login for a webhook push, which
    // belongs to no account here.
    creatorUserId: text("creator_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: isoTimestamptz("created_at").notNull(),
  },
  (t) => [
    index("deployments_app_created_idx").on(
      t.appId,
      t.createdAt.desc(),
      t.seq.desc(),
    ),
    // The deploy queue's hot path: pick the OLDEST queued deploy for a server. Partial
    // (queued-only) so it indexes just the live backlog, not the whole deploy history;
    // ascending (createdAt, seq) matches the drain's oldest-first ORDER BY.
    index("deployments_queued_server_idx")
      .on(t.serverId, t.createdAt, t.seq)
      .where(sql`${t.status} = 'queued'`),
    // The same hot path once a BUILD SERVER is in play: the queue drains on the
    // lane, `coalesce(build_server_id, server_id)`, which the index above cannot
    // serve. Its sibling stays because other readers still ask by owning server.
    index("deployments_queued_lane_idx")
      .on(sql`coalesce(${t.buildServerId}, ${t.serverId})`, t.createdAt, t.seq)
      .where(sql`${t.status} = 'queued'`),
    // A pull request preview's own build history, newest first.
    index("deployments_preview_idx").on(
      t.previewId,
      t.createdAt.desc(),
      t.seq.desc(),
    ),
  ],
);

/**
 * The `logs: Record<ID, LogLine[]>` map → child table (PLAN §2 `deployment_logs`).
 * `id bigint identity` PK reproduces `Array.push` order; `(deployment_id, id)`
 * index.
 */
export const deploymentLogs = pgTable(
  "deployment_logs",
  {
    id: bigint("id", { mode: "number" })
      .generatedAlwaysAsIdentity()
      .primaryKey(),
    deploymentId: text("deployment_id")
      .notNull()
      .references(() => deployments.id, { onDelete: "cascade" }),
    ts: isoTimestamptz("ts").notNull(),
    level: deploymentLogLevel("level").notNull(),
    text: text("text").notNull(),
  },
  (t) => [index("deployment_logs_deployment_idx").on(t.deploymentId, t.id)],
);

/**
 * A **pull request preview**: an ephemeral stack built from one open pull request
 * and torn down when it closes. It exists so a preview build can never repaint the
 * production App's badge.
 */
export const appPreviews = pgTable(
  "app_previews",
  {
    id: text("id").primaryKey(),
    appId: text("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    prNumber: integer("pr_number").notNull(),
    prTitle: text("pr_title").notNull().default(""),
    prAuthor: text("pr_author").notNull().default(""),
    prUrl: text("pr_url").notNull().default(""),
    headBranch: text("head_branch").notNull(),
    headSha: text("head_sha").notNull().default(""),
    /** `owner/name` of the HEAD repo. Differs from the App's repo ⇒ a fork. */
    headRepo: text("head_repo").notNull().default(""),
    /** The fork's own clone URL: a fork's head ref does not exist on the base
     *  repo, and `git clone --branch` accepts neither a SHA nor `refs/pull/N/head`. */
    headCloneUrl: text("head_clone_url").notNull().default(""),
    baseBranch: text("base_branch").notNull().default(""),
    isFork: boolean("is_fork").notNull().default(false),
    // Who unblocked a fork preview, and at which commit.
    approvedByUserId: text("approved_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    approvedAt: isoTimestamptz("approved_at"),
    approvedSha: text("approved_sha"),
    deployKey: text("deploy_key").notNull(),
    host: text("host").notNull(),
    /** What the host's router was rendered with, so the URL scheme stays stable. */
    certProvider: text("cert_provider").notNull().default("none"),
    /**
     * The container port this preview's router forwards to, minted from the app's
     * `preview_port` (or its build port) when the preview is created.
     */
    port: integer("port"),
    status: text("status").notNull().default("queued"),
    latestDeploymentId: text("latest_deployment_id").references(
      (): AnyPgColumn => deployments.id,
      { onDelete: "set null" },
    ),
    url: text("url").notNull().default(""),
    /** The ONE sticky comment Deplo edits in place instead of spamming the thread. */
    commentId: bigint("comment_id", { mode: "number" }),
    state: text("state").notNull().default("open"),
    closedAt: isoTimestamptz("closed_at"),
    tornDownAt: isoTimestamptz("torn_down_at"),
    lastActivityAt: isoTimestamptz("last_activity_at").notNull(),
    createdAt: isoTimestamptz("created_at").notNull(),
    updatedAt: isoTimestamptz("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("app_previews_app_pr_uq").on(t.appId, t.prNumber),
    uniqueIndex("app_previews_deploy_key_uq").on(t.deployKey),
    uniqueIndex("app_previews_host_uq").on(t.host),
    index("app_previews_app_idx").on(t.appId),
    // The reaper's two scans, each partial so it indexes only its working set:
    // open previews by idleness, and closed-but-not-torn-down ones to retry.
    index("app_previews_open_idx")
      .on(t.lastActivityAt)
      .where(sql`${t.state} = 'open'`),
    index("app_previews_untorn_idx")
      .on(t.closedAt)
      .where(sql`${t.tornDownAt} is null`),
  ],
);

/**
 * A stack that must die on a host that would not confirm it, kept until it does.
 * The identity is the id, never the slug.
 */
export const pendingTeardowns = pgTable(
  "pending_teardowns",
  {
    id: text("id").primaryKey(),
    /** The host that still holds it. Removing the server drops the row with it. */
    serverId: text("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    /** The compose project key: `<slug>`, `<slug>__pr-<n>`, or a database host. */
    deployKey: text("deploy_key").notNull(),
    /** The `deplo.project` label of what is being destroyed - the identity check. */
    projectLabel: text("project_label").notNull(),
    /** Human name for the Activity copy: by drain time the row it named is gone. */
    label: text("label").notNull(),
    /** NULL once the owning team is deleted, which is also "nowhere to report to". */
    teamId: text("team_id").references(() => teams.id, {
      onDelete: "set null",
    }),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error").notNull().default(""),
    nextAttemptAt: isoTimestamptz("next_attempt_at").notNull(),
    /** Set when the ladder ran out. Cleared when that server comes back online. */
    abandonedAt: isoTimestamptz("abandoned_at"),
    createdAt: isoTimestamptz("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("pending_teardowns_server_key_uq").on(t.serverId, t.deployKey),
  ],
);

/**
 * [EnvVar](../../types.ts). `value_enc` secret. Authorship (`created_by_user_id` /
 * `updated_by_user_id`) is METADATA, never a value: it is safe to project into a
 * DTO while `value_enc` stays write-only.
 */
export const envVars = pgTable(
  "env_vars",
  {
    id: text("id").primaryKey(),
    appId: text("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    valueEnc: text("value_enc").notNull(),
    type: text("type").notNull(),
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    updatedByUserId: text("updated_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: isoTimestamptz("created_at").notNull(),
    updatedAt: isoTimestamptz("updated_at").notNull(),
  },
  (t) => [uniqueIndex("env_vars_app_key_uq").on(t.appId, t.key)],
);

/**
 * Preview-only environment variable OVERRIDES (advanced). It is a separate table
 * rather than a second `env_vars` row because `env_vars_app_key_uq` is
 * `UNIQUE(app_id, key)` - two values for one key are not representable there.
 */
export const appPreviewEnvVars = pgTable(
  "app_preview_env_vars",
  {
    id: text("id").primaryKey(),
    appId: text("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    valueEnc: text("value_enc").notNull(),
    type: text("type").notNull().default("plain"),
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    updatedByUserId: text("updated_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: isoTimestamptz("created_at").notNull(),
    updatedAt: isoTimestamptz("updated_at").notNull(),
  },
  (t) => [uniqueIndex("app_preview_env_vars_app_key_uq").on(t.appId, t.key)],
);

/** [EnvVar.targets](../../types.ts) → junction. `target` ∈ production/preview. */
export const envVarTargets = pgTable(
  "env_var_targets",
  {
    envVarId: text("env_var_id")
      .notNull()
      .references(() => envVars.id, { onDelete: "cascade" }),
    target: text("target").notNull(),
  },
  (t) => [primaryKey({ columns: [t.envVarId, t.target] })],
);

// NOTE: `team_global_env_vars` (+ targets) was absorbed into the unified
// `shared_env_vars` model as team-wide-mode shared vars (ADR-0010); migration
// 0027 converts the rows and 0028 drops the tables.

/**
 * [GlobalEnvVar](../../types.ts) (instance scope) - a variable injected into EVERY
 * service of EVERY team (an instance-wide default), managed by an instance admin.
 */
export const instanceEnvVars = pgTable(
  "instance_env_vars",
  {
    id: text("id").primaryKey(),
    key: text("key").notNull(),
    valueEnc: text("value_enc").notNull(),
    type: text("type").notNull(),
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    updatedByUserId: text("updated_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: isoTimestamptz("created_at").notNull(),
    updatedAt: isoTimestamptz("updated_at").notNull(),
  },
  (t) => [uniqueIndex("instance_env_vars_key_uq").on(t.key)],
);

export const instanceEnvVarTargets = pgTable(
  "instance_env_var_targets",
  {
    envVarId: text("env_var_id")
      .notNull()
      .references(() => instanceEnvVars.id, { onDelete: "cascade" }),
    target: text("target").notNull(),
  },
  (t) => [primaryKey({ columns: [t.envVarId, t.target] })],
);

// NOTE: `environment_env_vars` was absorbed into the unified `shared_env_vars`
// model as environment-mode shared vars (ADR-0010); migration 0027 converts the
// rows (targets = all three, reproducing membership) and 0028 drops the table.

/**
 * [Domain](../../types.ts).
 */
export const domains = pgTable(
  "domains",
  {
    id: text("id").primaryKey(),
    appId: text("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    status: text("status").notNull(),
    isPrimary: boolean("is_primary").notNull(),
    redirectTo: text("redirect_to"),
    ssl: boolean("ssl").notNull(),
    source: text("source"),
    port: integer("port"),
    entrypoint: text("entrypoint"),
    certProvider: text("cert_provider"),
    pathPrefix: text("path_prefix"),
    stripPrefix: boolean("strip_prefix"),
    service: text("service"),
    // The hostname this row REPLACED on the platform it was imported from - set only
    // when the address actually changed (the source's own throwaway host, or a name
    // another team here already serves).
    importedFrom: text("imported_from"),
    createdAt: isoTimestamptz("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("domains_one_primary_uq")
      .on(t.appId)
      .where(sql`${t.isPrimary}`),
    uniqueIndex("domains_name_pathprefix_uq").on(
      t.name,
      sql`coalesce(${t.pathPrefix}, '')`,
    ),
    index("domains_app_idx").on(t.appId),
  ],
);

/** [Domain.middlewares](../../types.ts) → ordered child `(domain_id, position, name)`. */
export const domainMiddlewares = pgTable(
  "domain_middlewares",
  {
    domainId: text("domain_id")
      .notNull()
      .references(() => domains.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    name: text("name").notNull(),
  },
  (t) => [primaryKey({ columns: [t.domainId, t.position] })],
);

/**
 * [BasicAuthUser](../../types.ts) - an HTTP Basic Auth credential that gates EVERY
 * domain of a service.
 */
export const appBasicAuthUsers = pgTable(
  "app_basic_auth_users",
  {
    id: text("id").primaryKey(),
    appId: text("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    username: text("username").notNull(),
    passwordEnc: text("password_enc").notNull(),
    /**
     * Carried over from another platform, unchanged and unvetted.
     */
    imported: boolean("imported").notNull().default(false),
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    updatedByUserId: text("updated_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: isoTimestamptz("created_at").notNull(),
    updatedAt: isoTimestamptz("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("app_basic_auth_users_app_username_uq").on(t.appId, t.username),
    index("app_basic_auth_users_app_idx").on(t.appId),
  ],
);

/* ================================================================== */
/* Ordering junctions (after apps/folders exist)                  */
/* ================================================================== */

/**
 * Team-wide service display order (was `teams.project_order` jsonb ID[]).
 */
export const teamAppOrder = pgTable(
  "team_app_order",
  {
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    appId: text("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
  },
  (t) => [primaryKey({ columns: [t.teamId, t.appId] })],
);

/** Team-wide folder display order (was `teams.folder_order` jsonb ID[]). */
export const teamFolderOrder = pgTable(
  "team_folder_order",
  {
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    folderId: text("folder_id")
      .notNull()
      .references(() => folders.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
  },
  (t) => [primaryKey({ columns: [t.teamId, t.folderId] })],
);

/**
 * Team-wide Project-CONTAINER display order (ADR-0008) - the direct analogue of
 * `team_folder_order`/`team_app_order` for the new top-level container. PK
 * `(team_id, project_id)`, both FKs CASCADE so a dead id can't sit in the order.
 */
export const teamProjectOrder = pgTable(
  "team_project_order",
  {
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
  },
  (t) => [primaryKey({ columns: [t.teamId, t.projectId] })],
);

/* ================================================================== */
/* Data aggregate (databases / s3 / backups)                          */
/* ================================================================== */

/**
 * [Database](../../types.ts). `connection_string_enc` secret. `server_id`
 * `RESTRICT`. `UNIQUE(team_id, name)`.
 */
export const databases = pgTable(
  "databases",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    // DISPLAY name only - editable in Settings → General, like an App's. The
    // container's identity is `host` (the compose project / volume / DNS name),
    // frozen at create: renaming a database never touches the running stack.
    name: text("name").notNull(),
    // Uploaded display logo (a base64 image data-URI), or NULL to fall back to
    // the engine's own brand mark. Same column contract and validation as
    // `apps.logo`; purely cosmetic, never read by a deploy.
    logo: text("logo"),
    type: text("type").notNull(),
    version: text("version").notNull(),
    // The engine login the connection string authenticates as AND (except
    // mysql/mariadb, which always dump as root) the backup dump user.
    username: text("username").notNull(),
    // The logical database the engine creates on first init (POSTGRES_DB /
    // MYSQL_DATABASE / CLICKHOUSE_DB / mongo default DB).
    dbName: text("db_name").notNull(),
    status: text("status").notNull(),
    // The twin of `apps.data_copy_error`, and the one that matters most: an engine
    // started on a volume a failed migration emptied does not fail, it INITIALISES - a
    // brand new empty database, over the place the old one was meant to be.
    dataCopyError: text("data_copy_error").notNull().default(""),
    // The migration still creating this database. See the apps column.
    migrationRunId: text("migration_run_id"),
    serverId: text("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "restrict" }),
    host: text("host").notNull(),
    port: integer("port").notNull(),
    connectionStringEnc: text("connection_string_enc").notNull(),
    exposedPublicly: boolean("exposed_publicly").notNull(),
    // The HOST port the container publishes when exposedPublicly is true (the compose
    // `ports:` maps exposed_port:port).
    exposedPort: integer("exposed_port"),
    // Per-database resource limits - the exact flattened ResourceLimits shape and units
    // used on `apps` above (NULL ⇒ uncapped, all-NULL ⇒ `resources: null`; MiB / GiB /
    // milli-CPUs).
    resourceMemLimitMb: integer("resource_mem_limit_mb"),
    resourceMemReservationMb: integer("resource_mem_reservation_mb"),
    resourceMemSwapMb: integer("resource_mem_swap_mb"),
    resourceCpuMilli: integer("resource_cpu_milli"),
    resourceCpuShares: integer("resource_cpu_shares"),
    resourceCpuset: text("resource_cpuset"),
    resourcePidsLimit: integer("resource_pids_limit"),
    resourceShmSizeMb: integer("resource_shm_size_mb"),
    resourceStorageSizeGb: integer("resource_storage_size_gb"),
    resourceUlimitNofile: integer("resource_ulimit_nofile"),
    resourceUlimitNproc: integer("resource_ulimit_nproc"),
    resourceOomScoreAdj: integer("resource_oom_score_adj"),
    // Expert overrides, both applied at the next render/reroute.
    customImage: text("custom_image"),
    customCommand: text("custom_command"),
    // Cron jobs on this database's container - same opt-in switch, same default
    // and same reasoning as `apps.cron_enabled`. A database is a single-container
    // stack, so a job here needs no service selector.
    cronEnabled: boolean("cron_enabled").notNull().default(false),
    sizeMb: bigint("size_mb", { mode: "number" }).notNull(),
    createdAt: isoTimestamptz("created_at").notNull(),
  },
  (t) => [uniqueIndex("databases_team_name_uq").on(t.teamId, t.name)],
);

/**
 * [Database.mounts](../../types.ts) → ordered child of the engine's own CONFIG
 * FILES: `{filePath, content, mountPath}`.
 */
export const databaseMounts = pgTable(
  "database_mounts",
  {
    databaseId: text("database_id")
      .notNull()
      .references(() => databases.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    filePath: text("file_path").notNull(),
    content: text("content").notNull(),
    mountPath: text("mount_path").notNull(),
  },
  (t) => [primaryKey({ columns: [t.databaseId, t.position] })],
);

/**
 * Team-wide database display order for the Storage grid - the direct analogue of
 * `team_app_order` for the databases list.
 */
export const teamDatabaseOrder = pgTable(
  "team_database_order",
  {
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    databaseId: text("database_id")
      .notNull()
      .references(() => databases.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
  },
  (t) => [primaryKey({ columns: [t.teamId, t.databaseId] })],
);

/**
 * [BackupDestination](../../types.ts), where backup artifacts are kept. TWO kinds
 * behind one `kind` discriminator, because `backups.destination_id` and
 * `backup_runs.destination_id` must keep pointing at one table: - `s3` - a bucket.
 */
export const backupDestination = pgTable(
  "backup_destination",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    kind: text("kind").notNull(),
    provider: text("provider"),
    endpoint: text("endpoint"),
    region: text("region"),
    bucket: text("bucket"),
    accessKeyEnc: text("access_key_enc"),
    secretKeyEnc: text("secret_key_enc"),
    serverId: text("server_id").references(() => servers.id, {
      onDelete: "restrict",
    }),
    path: text("path"),
    ageRecipient: text("age_recipient"),
    ageIdentityEnc: text("age_identity_enc"),
    recoveryKeySavedAt: isoTimestamptz("recovery_key_saved_at"),
    // Opt OUT of the SSRF guard on the endpoint, for a bucket that lives on the
    // operator's own private network.
    allowPrivateEndpoint: boolean("allow_private_endpoint")
      .notNull()
      .default(false),
    // Advanced per-store quirk flags (`--s3-sign-accept-encoding=false`, …), as typed.
    s3ExtraArgs: text("s3_extra_args"),
    status: text("status").notNull(),
    createdAt: isoTimestamptz("created_at").notNull(),
    // Last "Test connection" verdict, kept so the card can say WHY a destination is in
    // `error` and the connection-log dialog can open on the previous run without
    // silently re-dialing the bucket. All four are NULL until the first test.
    lastTestAt: isoTimestamptz("last_test_at"),
    lastTestError: text("last_test_error"),
    // The server whose agent served the probe (for `s3`, any backup-capable one
    // can; for `server`, it is always that destination's own host).
    // SET NULL: removing a server must not delete a destination's history.
    lastTestServerId: text("last_test_server_id").references(() => servers.id, {
      onDelete: "set null",
    }),
    lastTestMs: integer("last_test_ms"),
    // Store destinations only: the filesystem headroom the last check saw, so the card
    // can show it without a second RPC.
    lastFreeBytes: bigint("last_free_bytes", { mode: "number" }),
    lastTotalBytes: bigint("last_total_bytes", { mode: "number" }),
    // The root the agent actually resolved (the managed one when `path` is
    // NULL), so the UI shows a real path rather than a blank.
    resolvedPath: text("resolved_path"),
  },
  (t) => [
    index("backup_destination_team_created_idx").on(
      t.teamId,
      t.createdAt.desc(),
    ),
    index("backup_destination_last_test_server_idx").on(t.lastTestServerId),
    index("backup_destination_server_idx").on(t.serverId),
    check(
      "backup_destination_kind_shape",
      // The age columns are no longer the `server` kind's alone: a bucket artifact is
      // encrypted too (migration 0086), because a project archive carries the app's whole
      // decrypted env and the bucket was the one place it landed in the clear.
      sql`(${t.kind} = 's3' and ${t.provider} is not null and ${t.endpoint} is not null
             and ${t.region} is not null and ${t.bucket} is not null
             and ${t.accessKeyEnc} is not null and ${t.secretKeyEnc} is not null
             and ${t.serverId} is null
             and ((${t.ageRecipient} is null and ${t.ageIdentityEnc} is null)
               or (${t.ageRecipient} is not null and ${t.ageIdentityEnc} is not null)))
          or (${t.kind} = 'server' and ${t.serverId} is not null and ${t.ageRecipient} is not null
             and ${t.ageIdentityEnc} is not null and ${t.bucket} is null
             and ${t.accessKeyEnc} is null and ${t.secretKeyEnc} is null)`,
    ),
  ],
);

/**
 * [Backup](../../types.ts) - schedule table (not run history).
 */
export const backups = pgTable(
  "backups",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    targetKind: text("target_kind").notNull(),
    databaseId: text("database_id").references(() => databases.id, {
      onDelete: "cascade",
    }),
    appId: text("app_id").references(() => apps.id, {
      onDelete: "cascade",
    }),
    destinationId: text("destination_id")
      .notNull()
      .references(() => backupDestination.id, { onDelete: "restrict" }),
    schedule: text("schedule").notNull(),
    // The IANA zone `schedule` is read in. "UTC" for every row that existed before
    // migration 0086, which is what they always meant.
    timezone: text("timezone").notNull().default("UTC"),
    retentionCount: integer("retention_count").notNull(),
    lastRunAt: isoTimestamptz("last_run_at"),
    lastStatus: text("last_status").notNull(),
    enabled: boolean("enabled").notNull(),
    createdAt: isoTimestamptz("created_at").notNull(),
  },
  (t) => [
    check(
      "backups_target_kind_xor",
      sql`(${t.targetKind} = 'database' and ${t.databaseId} is not null and ${t.appId} is null)
          or (${t.targetKind} = 'app' and ${t.appId} is not null and ${t.databaseId} is null)`,
    ),
  ],
);

/**
 * [BackupRun](../../types.ts) - history; a SEPARATE table, NOT a child of
 * `backups`. `size_bytes` MUST be `bigint`.
 */
export const backupRuns = pgTable(
  "backup_runs",
  {
    id: text("id").primaryKey(),
    seq: bigint("seq", { mode: "number" }).generatedAlwaysAsIdentity(),
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    backupId: text("backup_id").references(() => backups.id, {
      onDelete: "set null",
    }),
    targetKind: text("target_kind").notNull(),
    databaseId: text("database_id").references(() => databases.id, {
      onDelete: "set null",
    }),
    appId: text("app_id").references(() => apps.id, {
      onDelete: "set null",
    }),
    destinationId: text("destination_id")
      .notNull()
      .references(() => backupDestination.id, { onDelete: "restrict" }),
    // The target's id as PLAIN TEXT, alongside the two FK columns above.
    targetId: text("target_id").notNull(),
    objectKey: text("object_key").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    // How big the artifact is once DECRYPTED - the exact byte count a download hands
    // the browser, and so its Content-Length. NULL for every run taken before migration
    // 0092 and for one written by an agent that predates the field.
    decryptedSizeBytes: bigint("decrypted_size_bytes", { mode: "number" }),
    // Hex sha256 of the artifact AS WRITTEN (ciphertext, before any decryption). The
    // agent computes it on both halves of a relay and on an S3 upload; the control
    // plane compares them, records the winner here, and re-checks it before a restore.
    sha256: text("sha256"),
    // When the sweep FIRST saw this run's target gone, not when the backup ran.
    orphanedAt: isoTimestamptz("orphaned_at"),
    status: text("status").notNull(),
    error: text("error"),
    startedAt: isoTimestamptz("started_at").notNull(),
    finishedAt: isoTimestamptz("finished_at"),
  },
  (t) => [
    index("backup_runs_team_started_idx").on(
      t.teamId,
      t.startedAt.desc(),
      t.seq.desc(),
    ),
    index("backup_runs_running_idx")
      .on(t.status)
      .where(sql`${t.status} = 'running'`),
    // FK columns are ON DELETE SET NULL - index them so a delete's cascade is a
    // lookup, not a full-table scan (migration 0042).
    index("backup_runs_app_idx").on(t.appId),
    index("backup_runs_database_idx").on(t.databaseId),
    index("backup_runs_destination_idx").on(t.destinationId),
    // Retention and the orphan sweep both select by (team, target), which is the
    // pair that outlives the FKs above.
    index("backup_runs_team_target_idx").on(t.teamId, t.targetId),
    // The sweep asks only for runs whose target is already gone.
    index("backup_runs_orphaned_idx")
      .on(t.orphanedAt)
      .where(sql`${t.appId} is null and ${t.databaseId} is null`),
  ],
);

/**
 * [CronJob](../../types.ts) - a command run inside one container of an App or a
 * Database on a cron schedule.
 */
export const cronJobs = pgTable(
  "cron_jobs",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    targetKind: text("target_kind").notNull(),
    appId: text("app_id").references(() => apps.id, { onDelete: "cascade" }),
    databaseId: text("database_id").references(() => databases.id, {
      onDelete: "cascade",
    }),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    /** Compose service to exec into. NULL ⇒ the target's primary container. */
    service: text("service"),
    /** 5-field cron, evaluated in `timezone` (NOT in UTC). */
    schedule: text("schedule").notNull(),
    /** IANA zone, validated on write - `Intl` throws on an unknown one, and an
     *  unvalidated value would take down the whole scheduler tick. */
    timezone: text("timezone").notNull().default("UTC"),
    /** "sh" | "bash". A named shell the image lacks fails the run rather than
     *  silently substituting the other: `set -o pipefail` and `[[` change
     *  meaning between them. */
    shell: text("shell").notNull().default("sh"),
    command: text("command").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    /**
     * Per ATTEMPT, not per run: it is the agent's `docker exec` deadline, and the
     * agent knows nothing about the retry ladder.
     */
    timeoutSeconds: integer("timeout_seconds").notNull().default(3600),
    /** Total launches per scheduled fire: 1 = no retry, up to 4. */
    maxAttempts: integer("max_attempts").notNull().default(1),
    /** "skip" | "allow" - what to do when the previous run is still going. */
    overlap: text("overlap").notNull().default("skip"),
    /** Runs kept in the history for this job; older ones are pruned on settle. */
    keepRuns: integer("keep_runs").notNull().default(50),
    workdir: text("workdir"),
    user: text("user"),
    lastRunAt: isoTimestamptz("last_run_at"),
    lastStatus: text("last_status"),
    /** Surfaced on the job row so a job that has been silently `skipped` for a
     *  week (its container is stopped) is visible without adding an alert key. */
    lastSuccessAt: isoTimestamptz("last_success_at"),
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: isoTimestamptz("created_at").notNull(),
    updatedAt: isoTimestamptz("updated_at").notNull(),
  },
  (t) => [
    check(
      "cron_jobs_target_kind_xor",
      sql`(${t.targetKind} = 'app' and ${t.appId} is not null and ${t.databaseId} is null)
          or (${t.targetKind} = 'database' and ${t.databaseId} is not null and ${t.appId} is null)`,
    ),
    uniqueIndex("cron_jobs_app_name_uq").on(t.appId, t.name),
    uniqueIndex("cron_jobs_database_name_uq").on(t.databaseId, t.name),
    // The scheduler's scan: every tick reads the enabled jobs and nothing else.
    index("cron_jobs_enabled_idx")
      .on(t.enabled)
      .where(sql`${t.enabled}`),
    index("cron_jobs_team_idx").on(t.teamId),
  ],
);

/**
 * Extra environment for one cron job, on top of whatever the container already
 * has.
 */
export const cronJobEnv = pgTable(
  "cron_job_env",
  {
    id: text("id").primaryKey(),
    jobId: text("job_id")
      .notNull()
      .references(() => cronJobs.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    valueEnc: text("value_enc").notNull(),
    createdAt: isoTimestamptz("created_at").notNull(),
  },
  (t) => [uniqueIndex("cron_job_env_job_key_uq").on(t.jobId, t.key)],
);

/**
 * [CronRun](../../types.ts) - one scheduled fire of a cron job, retries included.
 * Only an agent restart genuinely loses a run, and calling that `failed` would
 * fire a failure alert for something that most likely succeeded.
 */
export const cronRuns = pgTable(
  "cron_runs",
  {
    id: text("id").primaryKey(),
    seq: bigint("seq", { mode: "number" }).generatedAlwaysAsIdentity(),
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    jobId: text("job_id")
      .notNull()
      .references(() => cronJobs.id, { onDelete: "cascade" }),
    status: text("status").notNull(),
    /** "schedule" | "manual" - a hand-pressed Run now is not a missed schedule. */
    trigger: text("trigger").notNull().default("schedule"),
    actor: text("actor").notNull().default("Scheduler"),
    /** The cron minute this run answers, as a UTC instant. */
    scheduledFor: isoTimestamptz("scheduled_for").notNull(),
    /** Wall-clock key for an hour-pinned schedule, instant key otherwise - see
     *  lib/crons/cron-tz.ts. The two halves of the DST problem need opposite
     *  keys, and picking one for both breaks the other. */
    dedupeKey: text("dedupe_key").notNull(),
    startedAt: isoTimestamptz("started_at").notNull(),
    finishedAt: isoTimestamptz("finished_at"),
    /** 0-based launch count for THIS fire. Output is always the last attempt's. */
    attempt: integer("attempt").notNull().default(0),
    nextAttemptAt: isoTimestamptz("next_attempt_at"),
    /** The agent's handle. Valid for that agent PROCESS only; a poll answering
     *  "not found" is how we learn the agent restarted under us. */
    agentJobId: text("agent_job_id"),
    exitCode: integer("exit_code"),
    stdout: text("stdout"),
    stderr: text("stderr"),
    /** Why it failed, or why it was skipped. Not command output. */
    error: text("error"),
    command: text("command").notNull(),
    container: text("container").notNull().default(""),
    timeoutSeconds: integer("timeout_seconds").notNull(),
    maxAttempts: integer("max_attempts").notNull(),
  },
  (t) => [
    uniqueIndex("cron_runs_dedupe_uq").on(t.jobId, t.dedupeKey),
    index("cron_runs_running_idx")
      .on(t.status)
      .where(sql`${t.status} = 'running'`),
    index("cron_runs_job_seq_idx").on(t.jobId, t.seq.desc()),
  ],
);

/* ================================================================== */
/* Per-team leaf collections                                          */
/* ================================================================== */

/**
 * [ApiToken](../../types.ts). A token carries its OWN capabilities
 * (`api_token_capabilities`) and an optional Project scope (`api_token_projects`);
 * it is never root by construction.
 */
export const apiTokens = pgTable(
  "api_tokens",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull(),
    prefix: text("prefix").notNull(),
    // May administer the WHOLE INSTANCE (users, servers, global env), not just its
    // teams.
    instanceAdmin: boolean("instance_admin").notNull().default(false),
    // The INTENT to be scoped, stored separately from the junctions on purpose: a
    // deleted project or app cascades its scope row away, and without this flag an
    // emptied scope would read as "no scope" and silently WIDEN the token to
    // everything.
    scoped: boolean("scoped").notNull().default(false),
    // Set when this token was minted by approving an OAuth consent instead of by the
    // tokens page, and names the client that presented itself.
    oauthClientId: text("oauth_client_id"),
    // When this credential stops working. NULL is "never", which is what every token
    // minted before this column existed keeps.
    expiresAt: isoTimestamptz("expires_at"),
    lastUsedAt: isoTimestamptz("last_used_at"),
    // When this token last spoke MCP, as opposed to `last_used_at`, which rises on any
    // authenticated request (GraphQL, a deploy hook, a tool call alike). NULL is "never
    // spoke MCP", which is where every token starts and where a CI token stays forever.
    mcpLastUsedAt: isoTimestamptz("mcp_last_used_at"),
    createdAt: isoTimestamptz("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("api_tokens_token_hash_uq").on(t.tokenHash),
    // One connection per (client, person): re-authorizing MOVES a connection
    // rather than leaving two the owner cannot tell apart.
    uniqueIndex("api_tokens_oauth_client_user_uq")
      .on(t.oauthClientId, t.userId)
      .where(sql`${t.oauthClientId} is not null`),
  ],
);

/**
 * A token's own capabilities - the same forty from `lib/capabilities.ts` a Role is
 * built from. `view` is the always-on floor and is stored explicitly, so "no rows"
 * never has two meanings.
 */
export const apiTokenCapabilities = pgTable(
  "api_token_capabilities",
  {
    tokenId: text("token_id")
      .notNull()
      .references(() => apiTokens.id, { onDelete: "cascade" }),
    capability: text("capability").notNull(),
  },
  (t) => [primaryKey({ columns: [t.tokenId, t.capability] })],
);

/**
 * What a token may REACH, as four junctions - one per level of the tree the editor
 * shows: whole Teams, whole Projects, whole Folders, individual Apps.
 */
export const apiTokenTeams = pgTable(
  "api_token_teams",
  {
    tokenId: text("token_id")
      .notNull()
      .references(() => apiTokens.id, { onDelete: "cascade" }),
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.tokenId, t.teamId] }),
    index("api_token_teams_team_idx").on(t.teamId),
  ],
);

export const apiTokenProjects = pgTable(
  "api_token_projects",
  {
    tokenId: text("token_id")
      .notNull()
      .references(() => apiTokens.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.tokenId, t.projectId] }),
    index("api_token_projects_project_idx").on(t.projectId),
  ],
);

export const apiTokenFolders = pgTable(
  "api_token_folders",
  {
    tokenId: text("token_id")
      .notNull()
      .references(() => apiTokens.id, { onDelete: "cascade" }),
    folderId: text("folder_id")
      .notNull()
      .references(() => folders.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.tokenId, t.folderId] }),
    index("api_token_folders_folder_idx").on(t.folderId),
  ],
);

export const apiTokenApps = pgTable(
  "api_token_apps",
  {
    tokenId: text("token_id")
      .notNull()
      .references(() => apiTokens.id, { onDelete: "cascade" }),
    appId: text("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.tokenId, t.appId] }),
    index("api_token_apps_app_idx").on(t.appId),
  ],
);

/**
 * [Activity](../../types.ts) - append-only. Backfill maps empty-string team_id to
 * a real team before NOT NULL+FK, and assigns `seq` in source-array order.
 */
export const activities = pgTable(
  "activities",
  {
    id: text("id").primaryKey(),
    seq: bigint("seq", { mode: "number" }).generatedAlwaysAsIdentity(),
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    message: text("message").notNull(),
    actor: text("actor").notNull(),
    actorUserId: text("actor_user_id"),
    appId: text("app_id").references(() => apps.id, {
      onDelete: "set null",
    }),
    createdAt: isoTimestamptz("created_at").notNull(),
  },
  (t) => [
    index("activities_team_created_idx").on(
      t.teamId,
      t.createdAt.desc(),
      t.seq.desc(),
    ),
    // app_id is ON DELETE SET NULL - index it so deleting an app doesn't scan the
    // whole activity history (migration 0042).
    index("activities_app_idx").on(t.appId),
    // "What has this person done?" - the per-user feed on an account's admin
    // page, which reads across every team and would otherwise seq-scan.
    index("activities_actor_created_idx").on(t.actorUserId, t.createdAt.desc()),
  ],
);

/**
 * ONE configured destination. Flat columns, not a child table per kind and never
 * JSONB: a channel is a fixed set of named heterogeneous fields, not a list, which
 * is the same reason the settings row this replaces was flat.
 */
export const notificationChannels = pgTable(
  "notification_channels",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    /** A `NotificationChannel`. Text, not an enum: the catalog changes, migrations shouldn't. */
    kind: text("kind").notNull(),
    name: text("name").notNull().default(""),
    enabled: boolean("enabled").notNull().default(true),
    url: text("url").notNull().default(""),
    target: text("target").notNull().default(""),
    secretEnc: text("secret_enc").notNull().default(""),
    secret2Enc: text("secret2_enc").notNull().default(""),
    /* ---- email only ---- */
    emailFrom: text("email_from").notNull().default(""),
    /** `smtp` | `resend` - see `EmailProvider`. Resend is the default transport. */
    emailProvider: text("email_provider").notNull().default("resend"),
    smtpHost: text("smtp_host").notNull().default(""),
    smtpPort: integer("smtp_port").notNull().default(587),
    smtpUser: text("smtp_user").notNull().default(""),
    createdAt: isoTimestamptz("created_at").notNull(),
  },
  (t) => [
    index("notification_channels_team_created_idx").on(t.teamId, t.createdAt),
  ],
);

/**
 * One row per alert ONE CHANNEL INSTANCE has been decided about - the `alerts`
 * list of a [NotificationChannelInstance](../../types.ts) (PLAN §1: a list is a
 * junction table, never a column per item).
 */
export const notificationAlerts = pgTable(
  "notification_alerts",
  {
    channelId: text("channel_id")
      .notNull()
      .references(() => notificationChannels.id, { onDelete: "cascade" }),
    /** An `AlertKey`. Text, not an enum: the catalog changes, migrations shouldn't. */
    alertKey: text("alert_key").notNull(),
    enabled: boolean("enabled").notNull(),
  },
  (t) => [primaryKey({ columns: [t.channelId, t.alertKey] })],
);

/**
 * One row per browser that opted into push (beta). Per USER because a push
 * subscription belongs to a device, not to a team; per TEAM because the alert is
 * the team's and the same person can hold two.
 */
export const pushSubscriptions = pgTable(
  "push_subscriptions",
  {
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    endpoint: text("endpoint").notNull(),
    /** The subscription's public key and auth secret (RFC 8291), not secrets of ours. */
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    createdAt: isoTimestamptz("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.teamId, t.userId, t.endpoint] }),
    index("push_subscriptions_team_idx").on(t.teamId),
  ],
);

/**
 * [Registry](../../types.ts). `password_enc` secret. `(team_id, created_at DESC)`
 * index. A LEAF collection (cut-set (a)) (PLAN §2).
 */
export const registries = pgTable(
  "registries",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    type: text("type").notNull(),
    registryUrl: text("registry_url").notNull(),
    username: text("username").notNull(),
    passwordEnc: text("password_enc").notNull(),
    createdAt: isoTimestamptz("created_at").notNull(),
  },
  (t) => [
    index("registries_team_created_idx").on(t.teamId, t.createdAt.desc()),
  ],
);

/**
 * [InstalledPlugin](../../types.ts).
 */
export const installedPlugins = pgTable(
  "installed_plugins",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    catalogId: text("catalog_id").notNull(),
    slug: text("slug").notNull(),
    version: text("version").notNull(),
    createdAt: isoTimestamptz("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("installed_plugins_team_catalog_uq").on(t.teamId, t.catalogId),
    uniqueIndex("installed_plugins_slug_uq").on(t.slug),
    index("installed_plugins_team_created_idx").on(
      t.teamId,
      t.createdAt.desc(),
    ),
  ],
);

/* ================================================================== */
/* Integrations aggregate                                             */
/* ================================================================== */

/* ================================================================== */
/* Unified shared variables (ADR-0010)                                */
/* ================================================================== */

// NOTE: the shared-env GROUP model (`shared_env_groups` + `shared_env_group_vars` /
// `_apps` / `_targets`) was flattened into the individual `shared_env_vars` model
// below.

/**
 * [SharedVar](../../types.ts) - ONE individual shared variable owned by a team,
 * the unified replacement for shared-env groups, environment-scoped vars, and
 * team-global vars (ADR-0010).
 */
export const sharedEnvVars = pgTable(
  "shared_env_vars",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    valueEnc: text("value_enc").notNull(),
    type: text("type").notNull(),
    teamWide: boolean("team_wide").notNull().default(false),
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    updatedByUserId: text("updated_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: isoTimestamptz("created_at").notNull(),
    updatedAt: isoTimestamptz("updated_at").notNull(),
  },
  (t) => [
    index("shared_env_vars_team_idx").on(t.teamId),
    index("shared_env_vars_team_key_idx").on(t.teamId, t.key),
  ],
);

/** [SharedVar.targets](../../types.ts) → junction. `target` ∈ production/preview. */
export const sharedEnvVarTargets = pgTable(
  "shared_env_var_targets",
  {
    varId: text("var_id")
      .notNull()
      .references(() => sharedEnvVars.id, { onDelete: "cascade" }),
    target: text("target").notNull(),
  },
  (t) => [primaryKey({ columns: [t.varId, t.target] })],
);

/** Sharing mode 1 (environment[]) → junction. FK CASCADE to the environment. */
export const sharedEnvVarEnvironments = pgTable(
  "shared_env_var_environments",
  {
    varId: text("var_id")
      .notNull()
      .references(() => sharedEnvVars.id, { onDelete: "cascade" }),
    environmentId: text("environment_id")
      .notNull()
      .references(() => environments.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.varId, t.environmentId] }),
    index("shared_env_var_environments_env_idx").on(t.environmentId),
  ],
);

/** Sharing mode 2 (projects[] whitelist) → junction. FK CASCADE to the project. */
export const sharedEnvVarProjects = pgTable(
  "shared_env_var_projects",
  {
    varId: text("var_id")
      .notNull()
      .references(() => sharedEnvVars.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.varId, t.projectId] }),
    index("shared_env_var_projects_project_idx").on(t.projectId),
  ],
);

/** The 4th mechanism - an explicit per-app link attached from the app UI. */
export const sharedEnvVarApps = pgTable(
  "shared_env_var_apps",
  {
    varId: text("var_id")
      .notNull()
      .references(() => sharedEnvVars.id, { onDelete: "cascade" }),
    appId: text("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.varId, t.appId] }),
    index("shared_env_var_apps_app_idx").on(t.appId),
  ],
);

/**
 * [GithubApp](../../types.ts). 3 secrets
 * (`client_secret_enc`/`webhook_secret_enc`/`private_key_enc`). `app_id` `bigint
 * UNIQUE` (the JWT issuer; numeric GitHub App id) (PLAN §2).
 */
export const githubApps = pgTable(
  "github_apps",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    appId: bigint("app_id", { mode: "number" }).notNull(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    clientId: text("client_id").notNull(),
    clientSecretEnc: text("client_secret_enc").notNull(),
    webhookSecretEnc: text("webhook_secret_enc").notNull(),
    privateKeyEnc: text("private_key_enc").notNull(),
    htmlUrl: text("html_url").notNull(),
    createdAt: isoTimestamptz("created_at").notNull(),
  },
  (t) => [uniqueIndex("github_apps_app_id_uq").on(t.appId)],
);

/**
 * [GithubInstallation](../../types.ts). `installation_id` `bigint UNIQUE` (upsert
 * conflict target; do NOT touch `created_at` on conflict). `account_type` pgEnum.
 * No `team_id` (scoped via the parent app) (PLAN §2).
 */
export const githubInstallation = pgTable(
  "github_installation",
  {
    id: text("id").primaryKey(),
    appId: text("app_id")
      .notNull()
      .references(() => githubApps.id, { onDelete: "cascade" }),
    installationId: bigint("installation_id", { mode: "number" }).notNull(),
    accountLogin: text("account_login").notNull(),
    accountType: githubAccountType("account_type").notNull(),
    avatarUrl: text("avatar_url").notNull(),
    createdAt: isoTimestamptz("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("github_installation_installation_id_uq").on(t.installationId),
  ],
);

/**
 * [GitConnection](../../types.ts) - a team's credentials for one git host that is
 * NOT GitHub (GitLab, Bitbucket, Gitea/Forgejo, or a plain git server). UNIQUE
 * because it is a routing key.
 */
export const gitConnections = pgTable(
  "git_connections",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    // gitlab | bitbucket | gitea | git. Plain text, no CHECK: a value written by
    // a newer binary must round-trip through an older one rather than break the
    // row (same reasoning as apps.framework).
    provider: text("provider").notNull(),
    label: text("label").notNull(),
    // Origin of the host, no trailing slash: https://gitlab.com,
    // https://git.acme.com. Self-hosted GitLab/Gitea is the main reason this
    // column exists at all.
    baseUrl: text("base_url").notNull(),
    // Opt OUT of the SSRF guard on `base_url`, for a git server that lives on the
    // operator's own private network.
    allowPrivateEndpoint: boolean("allow_private_endpoint")
      .notNull()
      .default(false),
    // The userinfo half of the clone URL. Provider-dependent and NOT cosmetic:
    // GitLab wants "oauth2", Bitbucket "x-token-auth", Gitea the real username.
    username: text("username").notNull(),
    tokenEnc: text("token_enc").notNull(),
    webhookSecretEnc: text("webhook_secret_enc").notNull(),
    webhookToken: text("webhook_token").notNull(),
    accountLogin: text("account_login").notNull().default(""),
    avatarUrl: text("avatar_url").notNull().default(""),
    // "ok" | "failing". Never NULL: a connection is proven at creation time, so
    // there is no "unknown" state to represent.
    health: text("health").notNull().default("ok"),
    healthError: text("health_error").notNull().default(""),
    // Only when the provider tells us (GitLab does, Gitea does not).
    tokenExpiresAt: isoTimestamptz("token_expires_at"),
    lastCheckedAt: isoTimestamptz("last_checked_at"),
    createdAt: isoTimestamptz("created_at").notNull(),
    createdBy: text("created_by").notNull(),
  },
  (t) => [
    uniqueIndex("git_connections_webhook_token_uq").on(t.webhookToken),
    index("git_connections_team_idx").on(t.teamId),
  ],
);

/* ================================================================== */
/* Docker cleanup                                                      */
/* ================================================================== */

/**
 * The Docker-cleanup POLICY - a SINGLETON row (`id` is a fixed `'default'`), not a
 * row per server. No `team_id`: servers are the one shared cross-team resource, so
 * this is instance-wide infra state like `servers.deploy_concurrency`.
 */
export const dockerCleanupPolicy = pgTable("docker_cleanup_policy", {
  /** Always `'default'`. The row is a singleton; the PK exists to enforce that. */
  id: text("id").primaryKey().default("default"),
  enabled: boolean("enabled").notNull(),
  /**
   * 5-field cron, evaluated in **UTC** by lib/backups/cron.ts (no timezone column,
   * no DST handling). Validated at write time: an unparseable expression never
   * matches, so it would silently mean "never run" rather than fail loudly.
   */
  schedule: text("schedule").notNull(),
  /**
   * CACHE scopes only (build cache / dangling images / orphan buildkit volumes):
   * reclaim objects older than this (docker's `--filter until=<n>h`); 0 = no age
   * filter.
   */
  minAgeHours: integer("min_age_hours").notNull(),
  /** `unused_app_images` only: how many of the newest images to keep per app slug
   *  (per built service, for compose stacks). Enforced by the nightly sweep AND
   *  right after each deploy. >= 1. */
  keepImagesPerApp: integer("keep_images_per_app").notNull(),
  createdAt: isoTimestamptz("created_at").notNull(),
  updatedAt: isoTimestamptz("updated_at").notNull(),
});

/**
 * The scopes the policy is allowed to reclaim - a LIST, so a junction table, never
 * a JSONB array.
 */
export const dockerCleanupPolicyScopes = pgTable(
  "docker_cleanup_policy_scopes",
  {
    policyId: text("policy_id")
      .notNull()
      .references(() => dockerCleanupPolicy.id, { onDelete: "cascade" }),
    scope: text("scope").notNull(),
  },
  (t) => [primaryKey({ columns: [t.policyId, t.scope] })],
);

/**
 * Servers the SCHEDULED sweep skips - the policy's opt-out list.
 */
export const dockerCleanupExcludedServers = pgTable(
  "docker_cleanup_excluded_servers",
  {
    serverId: text("server_id")
      .primaryKey()
      .references(() => servers.id, { onDelete: "cascade" }),
  },
);

/**
 * One cleanup RUN on one server - the history, and a SEPARATE table from the
 * policy (the `backup_runs` precedent).
 */
export const dockerCleanupRuns = pgTable(
  "docker_cleanup_runs",
  {
    id: text("id").primaryKey(),
    seq: bigint("seq", { mode: "number" }).generatedAlwaysAsIdentity(),
    serverId: text("server_id").references(() => servers.id, {
      onDelete: "set null",
    }),
    serverName: text("server_name").notNull(),
    /** `'manual'` | `'scheduled'`. */
    trigger: text("trigger").notNull(),
    /** The human's name, or `"Scheduler"` for a tick - free text, like `activities.actor`. */
    actor: text("actor").notNull(),
    /** `'running'` | `'success'` | `'failed'`. */
    status: text("status").notNull(),
    error: text("error"),
    reclaimedBytes: bigint("reclaimed_bytes", { mode: "number" }).notNull(),
    startedAt: isoTimestamptz("started_at").notNull(),
    finishedAt: isoTimestamptz("finished_at"),
  },
  (t) => [
    index("docker_cleanup_runs_server_started_idx").on(
      t.serverId,
      t.startedAt.desc(),
      t.seq.desc(),
    ),
    index("docker_cleanup_runs_running_idx")
      .on(t.status)
      .where(sql`${t.status} = 'running'`),
  ],
);

/**
 * The per-scope breakdown of one run - a LIST, so a child table.
 */
export const dockerCleanupRunItems = pgTable(
  "docker_cleanup_run_items",
  {
    runId: text("run_id")
      .notNull()
      .references(() => dockerCleanupRuns.id, { onDelete: "cascade" }),
    scope: text("scope").notNull(),
    reclaimedBytes: bigint("reclaimed_bytes", { mode: "number" }).notNull(),
    itemsRemoved: integer("items_removed").notNull(),
    skipped: boolean("skipped").notNull(),
    error: text("error"),
  },
  (t) => [primaryKey({ columns: [t.runId, t.scope] })],
);

/* ================================================================== */
/* Monitoring                                                          */
/* ================================================================== */

/**
 * Monitoring settings - a SINGLETON row like {@link dockerCleanupPolicy} (`id` is
 * a fixed `'default'`), and instance-wide for the same reason: servers are the one
 * shared cross-team resource, so whether the control plane keeps their metrics
 * history is a property of the fleet, not of a team.
 */
export const monitoringSettings = pgTable("monitoring_settings", {
  /** Always `'default'`. The row is a singleton; the PK exists to enforce that. */
  id: text("id").primaryKey().default("default"),
  /** Keep a rolling in-memory metrics history per server on the control plane. */
  saveMetrics: boolean("save_metrics").notNull(),
  updatedAt: isoTimestamptz("updated_at").notNull(),
});

/* ================================================================== */
/* Instance                                                            */
/* ================================================================== */

/**
 * Instance settings - a SINGLETON row (`id` fixed at `'default'`), the shape of
 * {@link monitoringSettings} / {@link dockerCleanupPolicy}. The first account had
 * no protection whatsoever.
 */
export const instanceSettings = pgTable("instance_settings", {
  /** Always `'default'`. The row is a singleton; the PK exists to enforce that. */
  id: text("id").primaryKey().default("default"),
  /** The instance owner - see the table comment. NULL means "unowned". */
  ownerUserId: text("owner_user_id").references(() => users.id),
  /**
   * The address this Deplo answers on (`https://deplo.example.com`), as the
   * operator set it in Settings → Deplo.
   */
  panelUrl: text("panel_url"),
  /**
   * The VAPID keypair that identifies THIS Deplo to every browser push service
   * (beta). NULL until then; the private half is encrypted like every other
   * secret.
   */
  vapidPublicKey: text("vapid_public_key"),
  vapidPrivateKeyEnc: text("vapid_private_key_enc"),
  /**
   * How far back the log viewer's time range may reach, in DAYS. Instance-wide
   * because the logs live on the HOST, which several teams share.
   */
  logMaxDays: integer("log_max_days").notNull().default(7),
  /**
   * Whether a person with no uploaded picture falls back to their Gravatar.
   * Instance-wide rather than per team, because it is a property of this
   * deployment's egress and policy, not of one team's taste.
   */
  gravatarEnabled: boolean("gravatar_enabled").notNull().default(true),
  updatedAt: isoTimestamptz("updated_at").notNull(),
});

/* ================================================================== */
/* Rate limiting                                                       */
/* ================================================================== */

/**
 * Fixed-window counters for the sensitive paths (login, the 2FA challenge, the
 * register link, the notification test button). Joining this to anything would
 * delete exactly the counters an attacker wants gone.
 */
export const rateLimits = pgTable(
  "rate_limits",
  {
    /** Opaque, caller-chosen: `login:email:<addr>`, `2fa-step-up:<userId>`, ... */
    key: text("key").primaryKey(),
    count: integer("count").notNull(),
    /** When the window ends. A row past it is treated as absent, then reused. */
    resetAt: isoTimestamptz("reset_at").notNull(),
  },
  (t) => [index("rate_limits_reset_at_idx").on(t.resetAt)],
);

/* ================================================================== */
/* Migration                                                           */
/* ================================================================== */

/**
 * One run of the importer - the report, kept. Shaped like {@link
 * dockerCleanupRuns} because it is the same kind of object: a long operation whose
 * outcome outlives the tab that started it.
 */
/**
 * Where Deplo dials a machine it imports FROM, remembered across attempts. Keyed
 * by the SOURCE because that is what it is about - this panel, this machine of
 * it, is reached here.
 */
/**
 * What a person chose to migrate, so the runner can carry it out without them.
 */
export const migrationRunTargets = pgTable(
  "migration_run_targets",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => migrationRuns.id, { onDelete: "cascade" }),
    seq: bigint("seq", { mode: "number" }).generatedAlwaysAsIdentity(),
    projectId: text("project_id").notNull(),
    /** Shown while the run works through it; the API is not re-read for a name. */
    projectName: text("project_name").notNull(),
    serviceId: text("service_id").notNull(),
    /** Where it LANDS. Where its data is READ from is derived, never chosen. */
    serverId: text("server_id"),
    buildServerId: text("build_server_id"),
    exposedPort: integer("exposed_port"),
    /**
     * Whether `exposedPort` is an instruction at all. The field is TRI-state -
     * absent keeps the source's own port, null publishes nothing, a number
     * publishes there - and one nullable column can only say two of the three.
     */
    exposedPortSet: boolean("exposed_port_set").notNull().default(false),
    /** `'pending'` | `'done'` | `'failed'`. */
    state: text("state").notNull().default("pending"),
  },
  (t) => [index("migration_run_targets_run_idx").on(t.runId, t.seq)],
);

/** Which Deplo server a whole source machine's services land on - the fallback
 *  under the per-service placement. `fromId` is `''` for the panel's own host. */
export const migrationRunServers = pgTable(
  "migration_run_servers",
  {
    runId: text("run_id")
      .notNull()
      .references(() => migrationRuns.id, { onDelete: "cascade" }),
    fromId: text("from_id").notNull(),
    toId: text("to_id").notNull(),
  },
  (t) => [primaryKey({ columns: [t.runId, t.fromId] })],
);

export const migrationSourceAddresses = pgTable(
  "migration_source_addresses",
  {
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    /** The panel origin, normalised: no trailing slash, no `/api`. */
    sourceUrl: text("source_url").notNull(),
    /** The panel's machine id; `''` is the host the panel runs on. */
    sourceId: text("source_id").notNull(),
    /** What Deplo dials: an IP, or a name that points straight at the machine. */
    address: text("address").notNull(),
    updatedAt: isoTimestamptz("updated_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.teamId, t.sourceUrl, t.sourceId] })],
);

export const migrationRuns = pgTable(
  "migration_runs",
  {
    id: text("id").primaryKey(),
    seq: bigint("seq", { mode: "number" }).generatedAlwaysAsIdentity(),
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    /** Origin of the source instance, no key, no path. */
    sourceUrl: text("source_url").notNull(),
    /** The source team or organization the token read, when it would say. */
    orgName: text("org_name"),
    /**
     * `'dokploy'` | `'coolify'` - which product this run read. Decided once at
     * Connect and never re-derived: the runner resumes hours later from this row,
     * and a detection that answered differently would point the data cutover at
     * the wrong API.
     */
    platform: text("platform").notNull().default("dokploy"),
    actor: text("actor").notNull(),
    /** `'running'` | `'done'` | `'failed'`. */
    status: text("status").notNull(),
    created: integer("created").notNull(),
    skipped: integer("skipped").notNull(),
    failed: integer("failed").notNull(),
    manual: integer("manual").notNull(),
    error: text("error"),
    startedAt: isoTimestamptz("started_at").notNull(),
    finishedAt: isoTimestamptz("finished_at"),
    /**
     * The source panel's API token, encrypted, for as long as the run needs it - NULL
     * the moment it leaves `running`. A deliberate reversal of "the key is never
     * stored".
     */
    apiKeyEnc: text("api_key_enc"),
    /** Whether this run may reach a private address (instance-admin only). */
    allowPrivate: boolean("allow_private").notNull().default(false),
    /** Progress the SERVER owns, so every viewer sees the same numbers. */
    totalSteps: integer("total_steps").notNull().default(0),
    doneSteps: integer("done_steps").notNull().default(0),
    /** What it is on right now, as a person would say it. */
    stepLabel: text("step_label"),
    /** `'config'` | `'data'` | `'done'`. */
    phase: text("phase").notNull().default("config"),
    /** Stop is a REQUEST: the thing that stops runs elsewhere and checks between steps. */
    stopRequested: boolean("stop_requested").notNull().default(false),
    /**
     * When the person who started it closed its report - and NULL for as long as
     * they have not.
     */
    reportSeenAt: isoTimestamptz("report_seen_at"),
    /** Liveness of whichever process is driving it; cold means take it over. */
    heartbeatAt: isoTimestamptz("heartbeat_at"),
    runnerOwner: text("runner_owner"),
    /**
     * WHO started it, as an id - `actor` is the display name for the trail. The
     * runner re-enters every normal gate under this identity via
     * `runWithIdentity`, the same way the deploy hook and the MCP server do.
     */
    actorUserId: text("actor_user_id"),
  },
  (t) => [
    index("migration_runs_team_started_idx").on(
      t.teamId,
      t.startedAt.desc(),
      t.seq.desc(),
    ),
  ],
);

/**
 * One line of a run's report: a thing that was created, skipped, refused, or
 * imported with something left to do by hand. A LIST under a run, so a child table
 * (never a JSONB column).
 */
export const migrationRunItems = pgTable(
  "migration_run_items",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => migrationRuns.id, { onDelete: "cascade" }),
    seq: bigint("seq", { mode: "number" }).generatedAlwaysAsIdentity(),
    /** `Project / Environment / service`, as the user saw it on the panel. */
    path: text("path").notNull(),
    /** What it was over there: `application` | `compose` | `postgres` | `domain` | ... */
    sourceKind: text("source_kind").notNull(),
    sourceName: text("source_name").notNull(),
    /** When it happened. A report read afterwards is a list; read WHILE it runs
     *  it is a log, and a log with no times is not one. */
    at: isoTimestamptz("at"),
    /**
     * The source service id this row came from, when the row IS a service. Null
     * on the rows that are not a service (a project, a domain, a note) and on
     * every row written before it existed.
     */
    sourceId: text("source_id"),
    /** `'created'` | `'skipped'` | `'failed'` | `'manual'`. */
    outcome: text("outcome").notNull(),
    /** What it became here: `app` | `database` | `project` | `environment` | ... */
    targetKind: text("target_kind"),
    targetId: text("target_id"),
    message: text("message"),
  },
  (t) => [index("migration_run_items_run_idx").on(t.runId, t.seq)],
);
