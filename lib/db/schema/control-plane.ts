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
 * Relational control-plane schema — the full normalization of the single JSONB
 * `deplo_state` document (relational-store PLAN §1, §2). Every collection in
 * `DeploData` ([lib/types.ts](../../types.ts)) gets a real table; every nested
 * object becomes a 1-to-1 child table and every list an ordered child / junction.
 * There is **NO JSONB column anywhere** (PLAN §1 "No JSONB anywhere").
 *
 * Conventions (PLAN §1 "Conventions"):
 *  - `text("id").primaryKey()` for app-minted ids (`newId("prj")` from
 *    [lib/ids.ts](../../ids.ts)) — never serial/uuid.
 *  - snake_case columns.
 *  - all `*_at` columns use the `isoTimestamptz` custom type ([./columns.ts](./columns.ts)),
 *    a `timestamp with time zone` that surfaces a canonical ISO `T…Z` STRING in
 *    Drizzle's codec layer and accepts an ISO string on write (what `nowIso()`
 *    produces). The Step -1 GATE proved plain `timestamp` shifts the hour and that
 *    a driver-level parser alone is not enough once reads go through Drizzle
 *    (`mode:"date"` re-wraps to a Date; `mode:"string"` bypasses the parser back to
 *    the space-separated form) — see `columns.ts` for the full rationale. The DDL
 *    is identical to `timestamptz`; only the read/write codec differs.
 *  - Secrets (`*_enc`, `*_hash`) stay as `text` holding ciphertext/hashes exactly
 *    as today; DTOs already drop them from projections (PLAN §1 "Secrets").
 *  - **Enums:** plain `text` with NO CHECK for the un-validated value sets
 *    (`framework`, `build_method`) — write paths today are unchecked, so a strict
 *    CHECK would reject legacy rows at backfill. A `pgEnum` is used only where the
 *    value set is closed AND legacy values are coerced at backfill
 *    (`deployment_log_level`, `github_account_type`, `dev_status`) (PLAN §1).
 *  - **`seq bigint generated always as identity`** on the append-only collections
 *    (`activities`, `deployments`, `backup_runs`) so a same-millisecond timestamp
 *    tie is still totally ordered: every sort is `ORDER BY created_at DESC, seq
 *    DESC` and retention ranks by `(created_at, seq)` (PLAN §5).
 *
 * Nothing reads these tables yet — Step 1 is additive (the tables + the generated
 * migration + the backfill engine); the cut-sets (Steps 2–5) switch readers over.
 */

/* ------------------------------------------------------------------ */
/* pgEnums — only the closed, coerce-at-backfill value sets            */
/* ------------------------------------------------------------------ */

/** [LogLevel](../../types.ts) — closed; verbose builds only ever emit these. */
export const deploymentLogLevel = pgEnum("deployment_log_level", [
  "info",
  "warn",
  "error",
  "debug",
  "command",
  "success",
]);

/** [GithubInstallation.accountType](../../types.ts) — GitHub's two account kinds. */
export const githubAccountType = pgEnum("github_account_type", [
  "User",
  "Organization",
]);

/** [DevStatus](../../types.ts) — push-only dev lifecycle; legacy unknown → 'off'. */
export const devStatus = pgEnum("dev_status", [
  "off",
  "starting",
  "running",
  "stopped",
  "error",
]);

/* ================================================================== */
/* Identity aggregate                                                  */
/* ================================================================== */

/**
 * [User](../../types.ts). Flat. `password_hash` is the scrypt hash (excluded from
 * default projections). The 4 optional instance-wide booleans become NOT NULL
 * DEFAULT false. `UNIQUE(lower(email))` (the app does case-insensitive checks)
 * and `UNIQUE(username)` are enforced by indexes below; no FKs out.
 */
export const users = pgTable(
  "users",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    username: text("username").notNull(),
    name: text("name").notNull(),
    passwordHash: text("password_hash").notNull(),
    role: text("role").notNull(),
    isInstanceAdmin: boolean("is_instance_admin").notNull().default(false),
    suspended: boolean("suspended").notNull().default(false),
    canExposePorts: boolean("can_expose_ports").notNull().default(false),
    canMountHostVolumes: boolean("can_mount_host_volumes")
      .notNull()
      .default(false),
    avatarColor: text("avatar_color").notNull(),
    createdAt: isoTimestamptz("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("users_email_lower_uq").on(sql`lower(${t.email})`),
    uniqueIndex("users_username_uq").on(t.username),
  ],
);

/**
 * [Team](../../types.ts). `UNIQUE(slug)`. `project_order`/`folder_order` are NO
 * LONGER columns — they moved to the `team_service_order`/`team_folder_order`
 * ordering junctions so the stale-id self-healing becomes a DB invariant (PLAN
 * §1 "Ordering junctions").
 */
export const teams = pgTable(
  "teams",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    plan: text("plan").notNull(),
    // The team's ABSOLUTE owner — the user who originally created the team (the
    // "crown"). Distinct from the `owner` *role*, which any number of members may
    // hold (assigned owners). The founder is immutable and unremovable by anyone;
    // an assigned owner can be managed/removed by any owner. NULLABLE: legacy
    // teams are backfilled to their earliest owner membership, and `ON DELETE SET
    // NULL` so deleting the founder's user account never dangles the FK (the team
    // is then left with no protected founder). See [Team.founderUserId](../../types.ts).
    founderUserId: text("founder_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: isoTimestamptz("created_at").notNull(),
  },
  (t) => [uniqueIndex("teams_slug_uq").on(t.slug)],
);

/**
 * [Folder](../../types.ts). Self-FK `parent_id` is a safety net only — the app's
 * re-parenting in `deleteFolder` is authoritative — so `ON DELETE SET NULL`
 * (never CASCADE, which would wrongly delete subtrees) (PLAN §2 `folders`).
 *
 * `owner_user_id` is the folder's OWNER — the user who created it. A folder is
 * private to its owner by default; other users get access through `folder_grants`.
 * NULLABLE with `ON DELETE SET NULL`: (a) legacy folders created before this
 * column exist and are backfilled to the team founder, and (b) deleting the
 * owner's account leaves an ownerless/team-managed folder rather than dangling
 * the FK or cascading a folder delete. Ownership is NOT cleared when the owner
 * merely leaves the team (the user row still exists); the DB only guarantees the
 * FK never dangles. A member with `manage_team` (and instance admins) manage any
 * folder regardless of ownership.
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
    createdAt: isoTimestamptz("created_at").notNull(),
    updatedAt: isoTimestamptz("updated_at").notNull(),
  },
  (t) => [index("folders_owner_idx").on(t.ownerUserId)],
);

/**
 * Per-folder access grants — the capabilities the folder OWNER hands to OTHER
 * users so they can see/use a folder that is otherwise private to the owner.
 * Mirrors `membership_capabilities`: one row per (folder, user, capability),
 * `.includes()`-checked in memory. The OWNER is NOT represented here — their
 * effective caps are derived from `folders.owner_user_id` (bounded by their team
 * caps), so this table holds grantees only. Both FKs CASCADE (drop the folder or
 * the grantee's account ⇒ the grant vanishes). PK `(folder_id, user_id,
 * capability)` closes the double-grant race and enables `ON CONFLICT DO NOTHING`;
 * `folder_grants_user_idx` powers the "which folders can this user reach?" lookup.
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
    role: text("role").notNull(),
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
 * [Invite](../../types.ts). `token_hash` UNIQUE. Partial `UNIQUE (team_id, email)
 * WHERE status='pending'` (a revoked/accepted invite escapes the predicate, so
 * history accumulates). `status` is a soft lifecycle (never hard-delete on
 * revoke). `invited_by` is a display name, NOT an FK. `capabilities` → junction.
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
 * [RegistrationLink](../../types.ts). `token_hash` UNIQUE. Consume via a
 * conditional `UPDATE … WHERE status='pending' AND expires_at>=now() RETURNING`
 * for single-use atomicity (PLAN §1 "THE hard one"). `created_by` /
 * `used_by_username` are denormalized display strings, NOT FKs.
 */
export const registrationLinks = pgTable(
  "registration_links",
  {
    id: text("id").primaryKey(),
    tokenHash: text("token_hash").notNull(),
    status: text("status").notNull(),
    // How the registrant's team is decided: 'own_team' (they name + own a fresh
    // team at registration, the historical behavior) or 'existing_teams' (an
    // admin pre-assigned them to existing teams — see registration_link_teams).
    // Defaults to 'own_team' so links minted before this column keep working.
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
 * one row per team with the role they'll receive. `team_id` cascades on team
 * delete, so a team removed before the link is used simply drops out of the
 * assignment (the consume path treats "no teams left" as the link being spent).
 * Mirrors the `invites` + `invite_capabilities` shape.
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
 * `servers`). Instance-wide: no `team_id`. Partial-unique on the fingerprint
 * excluding the empty/NULL sentinel; partial index on the live bootstrap token.
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
    // Team access scope. `true` (default) = available to every team — the
    // historical instance-wide behaviour. `false` restricts the server to the
    // teams enumerated in `server_teams`. See [Server.allTeams](../../types.ts).
    allTeams: boolean("all_teams").notNull().default(true),
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
 * `all_teams` is `false`: each row grants ONE team the right to target the
 * server for its services/databases. `all_teams = true` ignores this table
 * entirely (every team has access). Both FKs cascade — dropping a server or a
 * team prunes its grants. PK on both columns closes the double-grant race.
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
 * [Service](../../types.ts) — flat scalar columns only. `slug` UNIQUE *globally*.
 * `folder_id` `ON DELETE SET NULL` (orphan tolerated). `server_id` `RESTRICT`.
 * `latest_deployment_id` `SET NULL`. `repo`/`upload` flattened to columns (small
 * fixed shapes). `expose` is **NOT stored** — derived as `exposes[0]` in the
 * row-assembler (PLAN §2 `services`, Decision 14). Legacy `source="dockerfile"`
 * is rewritten on backfill by the shared normalizer.
 */
export const services = pgTable(
  "services",
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
    serverId: text("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "restrict" }),
    framework: text("framework").notNull(),
    logo: text("logo"),
    source: text("source").notNull(),
    // Flattened GitRepo (NULL columns when there is no repo).
    repoProvider: text("repo_provider"),
    repoUrl: text("repo_url"),
    repoRepo: text("repo_repo"),
    repoBranch: text("repo_branch"),
    repoInstallationId: text("repo_installation_id"),
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
    // Pointer to the service's latest Deployment. `SET NULL` so deleting a
    // deployment can't leave a dangling pointer (the orphan-prevention-as-DB-
    // invariant goal). The value is set in a second backfill pass after
    // deployments exist; the FK uses the forward-reference thunk because
    // `deployments` is declared later in this file (same pattern as
    // `folders.parentId`).
    latestDeploymentId: text("latest_deployment_id").references(
      (): AnyPgColumn => deployments.id,
      { onDelete: "set null" },
    ),
    createdAt: isoTimestamptz("created_at").notNull(),
    updatedAt: isoTimestamptz("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("services_slug_uq").on(t.slug),
    index("services_team_idx").on(t.teamId),
    index("services_folder_idx").on(t.folderId),
  ],
);

/**
 * [BuildConfig](../../types.ts) → 1-to-1 child (was `services.build`).
 * `project_id` PK + FK CASCADE. `framework`/`build_method` plain text, NO CHECK
 * (legacy values are coerced, never rejected). `runtime_version` (legacy
 * `nodeVersion` remapped by `normalizeBuildConfig` at backfill). The backfill
 * MUST run the read-time normalizer first so the NOT NULL columns hold (PLAN §2).
 */
export const serviceBuild = pgTable("service_build", {
  serviceId: text("service_id")
    .primaryKey()
    .references(() => services.id, { onDelete: "cascade" }),
  framework: text("framework").notNull(),
  buildMethod: text("build_method").notNull(),
  rootDirectory: text("root_directory").notNull(),
  installCommand: text("install_command").notNull(),
  buildCommand: text("build_command").notNull(),
  outputDirectory: text("output_directory").notNull(),
  startCommand: text("start_command").notNull(),
  runtimeVersion: text("runtime_version").notNull(),
  port: integer("port").notNull(),
});

/**
 * [BuildMethodSettings](../../types.ts) → 1-to-1 child (was nested
 * `methodSettings`). `project_id` PK + FK. Every field is a column; an
 * `updateProjectBuild` with a provided `methodSettings` object FULLY REPLACES
 * this row while the parent `service_build` columns merge field-by-field (PLAN §2
 * Decision 15). All columns nullable — every settings field is optional.
 */
export const serviceBuildMethodSettings = pgTable(
  "service_build_method_settings",
  {
    serviceId: text("service_id")
      .primaryKey()
      .references(() => services.id, { onDelete: "cascade" }),
    dockerfilePath: text("dockerfile_path"),
    dockerContextPath: text("docker_context_path"),
    dockerBuildStage: text("docker_build_stage"),
    railpackVersion: text("railpack_version"),
    nixpacksPublishDirectory: text("nixpacks_publish_directory"),
    herokuVersion: text("heroku_version"),
    staticSinglePageApp: boolean("static_single_page_app"),
  },
);

/**
 * [DevConfig](../../types.ts) → 1-to-1 child (was `services.dev`). `project_id`
 * PK + FK. **Row ABSENT = dev never enabled** — do NOT seed a default row (the
 * tri-state sentinel, PLAN §1 "Tri-states"). `dev_status` pgEnum, legacy unknown
 * → 'off'. `image_kind` is closed ('preset'|'custom') but coerced at backfill.
 */
export const serviceDev = pgTable("service_dev", {
  serviceId: text("service_id")
    .primaryKey()
    .references(() => services.id, { onDelete: "cascade" }),
  enabled: boolean("enabled").notNull(),
  status: devStatus("status").notNull(),
  imageKind: text("image_kind").notNull(),
  image: text("image").notNull(),
  devCommand: text("dev_command").notNull(),
  port: integer("port").notNull(),
  previewEnabled: boolean("preview_enabled").notNull(),
  // The stored dev preview hostname (random words baked in once); NULLABLE for
  // legacy rows enabled before this column existed — regenerated on next start.
  previewHost: text("preview_host"),
  latestStartAt: isoTimestamptz("latest_start_at"),
});

/**
 * [VolumeMount](../../types.ts) → ordered child. `type` NULLABLE (the
 * named/`host`/`service` discriminant; absent ⇒ "named"). Backfill runs
 * `normalizeVolumes` first (drops mountless entries) so the NOT NULL child
 * columns hold (PLAN §2 `service_volumes`).
 */
export const serviceVolumes = pgTable(
  "service_volumes",
  {
    serviceId: text("service_id")
      .notNull()
      .references(() => services.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    volumeId: text("volume_id").notNull(),
    type: text("type"),
    name: text("name").notNull(),
    projectPath: text("project_path"),
    hostPath: text("host_path"),
    mountPath: text("mount_path").notNull(),
    readOnly: boolean("read_only").notNull(),
  },
  (t) => [primaryKey({ columns: [t.serviceId, t.position] })],
);

/**
 * [Service.mounts](../../types.ts) → ordered child of `{filePath, content}`
 * template config files. `content` is byte-preserved (reconciliation asserts
 * byte-equality, PLAN §2 `service_mounts` / Decision 14).
 */
export const serviceMounts = pgTable(
  "service_mounts",
  {
    serviceId: text("service_id")
      .notNull()
      .references(() => services.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    filePath: text("file_path").notNull(),
    content: text("content").notNull(),
  },
  (t) => [primaryKey({ columns: [t.serviceId, t.position] })],
);

/**
 * [Deployment](../../types.ts) — fully flat. `seq bigint identity` (PLAN §5) so
 * sorts are `ORDER BY created_at DESC, seq DESC`. `(project_id, created_at DESC,
 * seq DESC)` index. No `team_id` (joined via service). `build_source` is the
 * optional "dev-workspace" intent (absent ⇒ the service's own source).
 */
export const deployments = pgTable(
  "deployments",
  {
    id: text("id").primaryKey(),
    seq: bigint("seq", { mode: "number" }).generatedAlwaysAsIdentity(),
    serviceId: text("service_id")
      .notNull()
      .references(() => services.id, { onDelete: "cascade" }),
    status: text("status").notNull(),
    environment: text("environment").notNull(),
    commitSha: text("commit_sha").notNull(),
    commitMessage: text("commit_message").notNull(),
    commitAuthor: text("commit_author").notNull(),
    branch: text("branch").notNull(),
    url: text("url").notNull(),
    readyAt: isoTimestamptz("ready_at"),
    buildDurationMs: bigint("build_duration_ms", { mode: "number" }),
    creator: text("creator").notNull(),
    buildSource: text("build_source"),
    createdAt: isoTimestamptz("created_at").notNull(),
  },
  (t) => [
    index("deployments_service_created_idx").on(
      t.serviceId,
      t.createdAt.desc(),
      t.seq.desc(),
    ),
  ],
);

/**
 * The `logs: Record<ID, LogLine[]>` map → child table (PLAN §2
 * `deployment_logs`). Map key → `deployment_id` FK; each `LogLine` → one row.
 * `id bigint identity` PK reproduces `Array.push` order; `(deployment_id, id)`
 * index. `level` is the `deployment_log_level` pgEnum. Written via a batched
 * buffer at the service-graph cut-set, NOT per-line (PLAN §6 Decision 18).
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
 * [EnvVar](../../types.ts). `value_enc` secret. `UNIQUE(project_id, key)` enables
 * `ON CONFLICT` upsert. `targets` → `env_var_targets` junction.
 */
export const envVars = pgTable(
  "env_vars",
  {
    id: text("id").primaryKey(),
    serviceId: text("service_id")
      .notNull()
      .references(() => services.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    valueEnc: text("value_enc").notNull(),
    type: text("type").notNull(),
    createdAt: isoTimestamptz("created_at").notNull(),
    updatedAt: isoTimestamptz("updated_at").notNull(),
  },
  (t) => [uniqueIndex("env_vars_service_key_uq").on(t.serviceId, t.key)],
);

/** [EnvVar.targets](../../types.ts) → junction. `target` ∈ production/preview/development. */
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

/**
 * [GlobalEnvVar](../../types.ts) (team scope) — a variable injected into EVERY
 * service of a team (a team-wide default). Same shape as `env_vars` but keyed on
 * the team instead of a single service. `UNIQUE(team_id, key)`; `targets` →
 * junction. Lower deploy precedence than a service's own var (a service can
 * override it) — see lib/deploy/env-resolve.ts.
 */
export const teamGlobalEnvVars = pgTable(
  "team_global_env_vars",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    valueEnc: text("value_enc").notNull(),
    type: text("type").notNull(),
    createdAt: isoTimestamptz("created_at").notNull(),
    updatedAt: isoTimestamptz("updated_at").notNull(),
  },
  (t) => [uniqueIndex("team_global_env_vars_team_key_uq").on(t.teamId, t.key)],
);

export const teamGlobalEnvVarTargets = pgTable(
  "team_global_env_var_targets",
  {
    envVarId: text("env_var_id")
      .notNull()
      .references(() => teamGlobalEnvVars.id, { onDelete: "cascade" }),
    target: text("target").notNull(),
  },
  (t) => [primaryKey({ columns: [t.envVarId, t.target] })],
);

/**
 * [GlobalEnvVar](../../types.ts) (instance scope) — a variable injected into
 * EVERY service of EVERY team (an instance-wide default), managed by an instance
 * admin. No team scope. `UNIQUE(key)`; `targets` → junction. The LOWEST deploy
 * precedence — any more-specific scope (team-global, service, shared) overrides
 * it. See lib/deploy/env-resolve.ts.
 */
export const instanceEnvVars = pgTable(
  "instance_env_vars",
  {
    id: text("id").primaryKey(),
    key: text("key").notNull(),
    valueEnc: text("value_enc").notNull(),
    type: text("type").notNull(),
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

/**
 * [Domain](../../types.ts). `primary` is a SQL reserved word → mapped to
 * `is_primary`. Partial `UNIQUE (project_id) WHERE is_primary`. `UNIQUE (name,
 * COALESCE(path_prefix,''))`. `entrypoint`/`cert_provider`/`source` NULLABLE with
 * NO DEFAULT — the auto/manual tri-state (never coerce NULL→'websecure') (PLAN §2
 * `domains`). `middlewares` → `domain_middlewares` junction.
 */
export const domains = pgTable(
  "domains",
  {
    id: text("id").primaryKey(),
    serviceId: text("service_id")
      .notNull()
      .references(() => services.id, { onDelete: "cascade" }),
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
    createdAt: isoTimestamptz("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("domains_one_primary_uq")
      .on(t.serviceId)
      .where(sql`${t.isPrimary}`),
    uniqueIndex("domains_name_pathprefix_uq").on(
      t.name,
      sql`coalesce(${t.pathPrefix}, '')`,
    ),
    index("domains_service_idx").on(t.serviceId),
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
 * [BasicAuthUser](../../types.ts) — an HTTP Basic Auth credential that gates
 * EVERY domain of a service. When a service has any of these, the renderers
 * inject a generated Traefik `basicauth` middleware (built from these users) at
 * the head of every router's middleware chain, so all the service's hostnames
 * sit behind the login prompt. `password_enc` is a REVERSIBLE secret (AES-GCM,
 * like `env_vars.value_enc` and `dev_ssh_users.password_enc`) so the htpasswd
 * line can be re-derived on every stack render; it is write-only over the API
 * (never returned). `UNIQUE(project_id, username)` — one credential per name.
 */
export const serviceBasicAuthUsers = pgTable(
  "service_basic_auth_users",
  {
    id: text("id").primaryKey(),
    serviceId: text("service_id")
      .notNull()
      .references(() => services.id, { onDelete: "cascade" }),
    username: text("username").notNull(),
    passwordEnc: text("password_enc").notNull(),
    createdAt: isoTimestamptz("created_at").notNull(),
    updatedAt: isoTimestamptz("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("service_basic_auth_users_service_username_uq").on(
      t.serviceId,
      t.username,
    ),
    index("service_basic_auth_users_service_idx").on(t.serviceId),
  ],
);

/**
 * [DevSshUser](../../types.ts). `password_enc` reversible secret (write-only,
 * masked as `hasPassword`). `UNIQUE(username)` globally. CHECK `public_key IS NOT
 * NULL OR password_enc IS NOT NULL` (at least one credential) (PLAN §2).
 */
export const devSshUser = pgTable(
  "dev_ssh_user",
  {
    id: text("id").primaryKey(),
    serviceId: text("service_id")
      .notNull()
      .references(() => services.id, { onDelete: "cascade" }),
    username: text("username").notNull(),
    publicKey: text("public_key"),
    passwordEnc: text("password_enc"),
    createdAt: isoTimestamptz("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("dev_ssh_user_username_uq").on(t.username),
    check(
      "dev_ssh_user_has_credential",
      sql`${t.publicKey} is not null or ${t.passwordEnc} is not null`,
    ),
  ],
);

/* ================================================================== */
/* Ordering junctions (after services/folders exist)                  */
/* ================================================================== */

/**
 * Team-wide service display order (was `teams.project_order` jsonb ID[]). PK
 * `(team_id, project_id)`; `ON DELETE CASCADE` on both FKs makes the stale-id
 * self-healing a DB invariant — a dead id can no longer sit in the order (PLAN §1
 * "Ordering junctions", §2 `team_service_order`).
 */
export const teamServiceOrder = pgTable(
  "team_service_order",
  {
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    serviceId: text("service_id")
      .notNull()
      .references(() => services.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
  },
  (t) => [primaryKey({ columns: [t.teamId, t.serviceId] })],
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
    name: text("name").notNull(),
    type: text("type").notNull(),
    version: text("version").notNull(),
    // The engine login the connection string authenticates as AND (except
    // mysql/mariadb, which always dump as root) the backup dump user. Stored
    // per-field; the password stays inside connection_string_enc. Honored by the
    // official images ONLY on first init against an empty volume, so it is
    // create-only / display-only on edit. Backfilled engine-aware:
    // redis='default', everything else='app' (matching the historical
    // connection-string identity in createDatabase).
    username: text("username").notNull(),
    // The logical database the engine creates on first init (POSTGRES_DB /
    // MYSQL_DATABASE / CLICKHOUSE_DB / mongo default DB). Single source of truth
    // for the logical DB name — the compose *_DB env, the connection-string path
    // segment, and the backup dump target all read it. Backfilled to `host`
    // (== the service name `db-<name>`, which is the logical DB existing rows
    // actually created), so legacy backups dump the identical database. Redis has
    // no logical DB, so its stored value is an inert placeholder.
    dbName: text("db_name").notNull(),
    status: text("status").notNull(),
    serverId: text("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "restrict" }),
    host: text("host").notNull(),
    port: integer("port").notNull(),
    connectionStringEnc: text("connection_string_enc").notNull(),
    exposedPublicly: boolean("exposed_publicly").notNull(),
    // The HOST port the container publishes when exposedPublicly is true (the
    // compose `ports:` maps exposed_port:port). Null when not exposed. Distinct
    // from `port` (the in-container engine port) so a user can publish on a free
    // host port — e.g. 25432 on the host mapped to postgres' 5432 inside — instead
    // of colliding with whatever already owns the engine's default port on that
    // host (a system Postgres, the control plane's own DB, another DB stack).
    exposedPort: integer("exposed_port"),
    sizeMb: bigint("size_mb", { mode: "number" }).notNull(),
    createdAt: isoTimestamptz("created_at").notNull(),
  },
  (t) => [uniqueIndex("databases_team_name_uq").on(t.teamId, t.name)],
);

/**
 * [S3Destination](../../types.ts). `access_key_enc`/`secret_key_enc` secrets (the
 * secret key is never even masked-returned). `(team_id, created_at DESC)` index.
 */
export const s3Destination = pgTable(
  "s3_destination",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    provider: text("provider").notNull(),
    endpoint: text("endpoint").notNull(),
    region: text("region").notNull(),
    bucket: text("bucket").notNull(),
    accessKeyEnc: text("access_key_enc").notNull(),
    secretKeyEnc: text("secret_key_enc").notNull(),
    status: text("status").notNull(),
    createdAt: isoTimestamptz("created_at").notNull(),
  },
  (t) => [index("s3_destination_team_created_idx").on(t.teamId, t.createdAt.desc())],
);

/**
 * [Backup](../../types.ts) — schedule table (not run history). `target_kind` XOR
 * CHECK on `database_id`/`project_id`. `destination_id` `RESTRICT`;
 * database/service/team `CASCADE`. `last_status` includes 'never' (wider than run
 * status) (PLAN §2 `backups`).
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
    serviceId: text("service_id").references(() => services.id, {
      onDelete: "cascade",
    }),
    destinationId: text("destination_id")
      .notNull()
      .references(() => s3Destination.id, { onDelete: "restrict" }),
    schedule: text("schedule").notNull(),
    retentionDays: integer("retention_days").notNull(),
    lastRunAt: isoTimestamptz("last_run_at"),
    lastStatus: text("last_status").notNull(),
    enabled: boolean("enabled").notNull(),
    createdAt: isoTimestamptz("created_at").notNull(),
  },
  (t) => [
    check(
      "backups_target_kind_xor",
      sql`(${t.targetKind} = 'database' and ${t.databaseId} is not null and ${t.serviceId} is null)
          or (${t.targetKind} = 'service' and ${t.serviceId} is not null and ${t.databaseId} is null)`,
    ),
  ],
);

/**
 * [BackupRun](../../types.ts) — history; a SEPARATE table, NOT a child of
 * `backups`. `seq bigint identity` (PLAN §5). `backup_id` `SET NULL` (history
 * outlives the schedule). `database_id`/`project_id` `SET NULL`. `size_bytes`
 * MUST be `bigint`. Partial index `WHERE status='running'` for boot reconcile.
 * Retention (`selectDoomedRuns`) orders by `(created_at, seq)`, never timestamp
 * alone (PLAN §5). Note: the `BackupRun` shape times via `startedAt`/`finishedAt`
 * (no `createdAt`); `started_at` is the run's creation instant for the `seq`-tied
 * ordering.
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
    serviceId: text("service_id").references(() => services.id, {
      onDelete: "set null",
    }),
    destinationId: text("destination_id")
      .notNull()
      .references(() => s3Destination.id, { onDelete: "restrict" }),
    objectKey: text("object_key").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
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
  ],
);

/* ================================================================== */
/* Per-team leaf collections                                          */
/* ================================================================== */

/**
 * [ApiToken](../../types.ts). `token_hash` UNIQUE (hot auth lookup). CASCADE on
 * team and user. A LEAF collection (cut-set (a) — zero-cost-revert) (PLAN §2).
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
    lastUsedAt: isoTimestamptz("last_used_at"),
    createdAt: isoTimestamptz("created_at").notNull(),
  },
  (t) => [uniqueIndex("api_tokens_token_hash_uq").on(t.tokenHash)],
);

/**
 * [Activity](../../types.ts) — append-only. `seq bigint identity` (PLAN §5): all
 * sorts `ORDER BY created_at DESC, seq DESC`, push-down LIMIT into SQL. `(team_id,
 * created_at DESC, seq DESC)` index. `actor` free text (incl. "system"), NOT an
 * FK. `project_id` `SET NULL`. Backfill maps empty-string team_id to a real team
 * before NOT NULL+FK, and assigns `seq` in source-array order.
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
    serviceId: text("service_id").references(() => services.id, {
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
  ],
);

/**
 * [NotificationSettings](../../types.ts) — the `Record<teamId, …>` map → one row
 * per team: `team_id` IS the PK. Channels AND `events` flattened to columns (no
 * JSONB map): `*_enabled`/`*_url`/`email_address` + one boolean per event.
 * Missing row = `defaultNotificationSettings()`. A LEAF collection (cut-set (a))
 * (PLAN §2 `notification_settings`).
 */
export const notificationSettings = pgTable("notification_settings", {
  teamId: text("team_id")
    .primaryKey()
    .references(() => teams.id, { onDelete: "cascade" }),
  // Channels.
  pushEnabled: boolean("push_enabled").notNull(),
  emailEnabled: boolean("email_enabled").notNull(),
  emailAddress: text("email_address").notNull(),
  discordEnabled: boolean("discord_enabled").notNull(),
  discordWebhookUrl: text("discord_webhook_url").notNull(),
  webhookEnabled: boolean("webhook_enabled").notNull(),
  webhookUrl: text("webhook_url").notNull(),
  // Events (one boolean per NotificationEvent).
  deploymentFailed: boolean("deployment_failed").notNull(),
  deploymentSucceeded: boolean("deployment_succeeded").notNull(),
  serverOffline: boolean("server_offline").notNull(),
  highResourceUsage: boolean("high_resource_usage").notNull(),
  updateAvailable: boolean("update_available").notNull(),
});

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
  (t) => [index("registries_team_created_idx").on(t.teamId, t.createdAt.desc())],
);

/**
 * [InstalledApp](../../types.ts). `UNIQUE(team_id, catalog_id)` + `UNIQUE(slug)`.
 * `(team_id, created_at DESC)` index. `status`/`url` deliberately NOT stored
 * (computed). Backfill derives the `slug` for legacy empty-slug rows. A LEAF
 * collection (cut-set (a)) (PLAN §2).
 */
export const installedApps = pgTable(
  "installed_apps",
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
    uniqueIndex("installed_apps_team_catalog_uq").on(t.teamId, t.catalogId),
    uniqueIndex("installed_apps_slug_uq").on(t.slug),
    index("installed_apps_team_created_idx").on(t.teamId, t.createdAt.desc()),
  ],
);

/* ================================================================== */
/* Integrations aggregate                                             */
/* ================================================================== */

/**
 * [SharedEnvGroup](../../types.ts) (+3 children). The parent holds scalars;
 * `variables` → `shared_env_group_vars`, `projectIds` → `shared_env_group_services`
 * (true junction), `targets` → `shared_env_group_targets` (was `targets` jsonb on
 * the parent) (PLAN §2 `shared_env_groups`).
 */
export const sharedEnvGroups = pgTable("shared_env_groups", {
  id: text("id").primaryKey(),
  teamId: text("team_id")
    .notNull()
    .references(() => teams.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description").notNull(),
  createdAt: isoTimestamptz("created_at").notNull(),
  updatedAt: isoTimestamptz("updated_at").notNull(),
});

/** [SharedEnvVar](../../types.ts) → child. `value_enc` secret. PK `(group_id, key)`, whole-set replace. */
export const sharedEnvGroupVars = pgTable(
  "shared_env_group_vars",
  {
    groupId: text("group_id")
      .notNull()
      .references(() => sharedEnvGroups.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    valueEnc: text("value_enc").notNull(),
    type: text("type").notNull(),
  },
  (t) => [primaryKey({ columns: [t.groupId, t.key] })],
);

/**
 * [SharedEnvGroup.projectIds](../../types.ts) → true junction. PK `(group_id,
 * project_id)`, index `project_id`. `project_id` CASCADE so a deleted service's
 * attachment rows vanish (this is the orphan the live `deleteProject` bug leaks —
 * a DB invariant now, PLAN §7).
 */
export const sharedEnvGroupServices = pgTable(
  "shared_env_group_services",
  {
    groupId: text("group_id")
      .notNull()
      .references(() => sharedEnvGroups.id, { onDelete: "cascade" }),
    serviceId: text("service_id")
      .notNull()
      .references(() => services.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.groupId, t.serviceId] }),
    index("shared_env_group_services_service_idx").on(t.serviceId),
  ],
);

/** [SharedEnvGroup.targets](../../types.ts) → junction. */
export const sharedEnvGroupTargets = pgTable(
  "shared_env_group_targets",
  {
    groupId: text("group_id")
      .notNull()
      .references(() => sharedEnvGroups.id, { onDelete: "cascade" }),
    target: text("target").notNull(),
  },
  (t) => [primaryKey({ columns: [t.groupId, t.target] })],
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
