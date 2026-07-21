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
 *    (`deployment_log_level`, `github_account_type`) (PLAN §1).
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
    // Bumped to invalidate every outstanding deplo_session cookie for this user
    // (password change / admin reset / sign-out-everywhere). The signed session
    // payload carries this value; a mismatch fails auth (migration 0043).
    tokenVersion: integer("token_version").notNull().default(0),
    createdAt: isoTimestamptz("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("users_email_lower_uq").on(sql`lower(${t.email})`),
    uniqueIndex("users_username_uq").on(t.username),
  ],
);

/**
 * [Team](../../types.ts). `UNIQUE(slug)`. `project_order`/`folder_order` are NO
 * LONGER columns — they moved to the `team_app_order`/`team_folder_order`
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
    // The Project CONTAINER this folder lives in, or NULL when the folder sits at
    // the team top level (additive adoption — ADR-0008). `ON DELETE SET NULL`:
    // deleting a container orphans its folders back to the top level rather than
    // cascading a delete. Forward-ref thunk because `projects` (the container) is
    // declared just below.
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
 * [Project](../../types.ts) — the top-level, team-scoped CONTAINER introduced in
 * ADR-0008 (folder-like, but it owns Environments). Modeled on `folders`: an
 * owner + per-container `project_grants` + `color` + team-wide ordering
 * (`team_project_order`). It has NO `parent_id` — a Project never nests in a
 * Project. Folders and Apps point INTO it via their nullable `project_id`.
 * `slug` is UNIQUE PER TEAM (kept for the legacy `/projects/<slug>` redirect;
 * the UI opens containers on the Overview via `/?project=<id>`). id prefix `prc_`.
 * The table name `projects` is reclaimed after the 0015 rename freed it (the old
 * deployable-app `projects` is now `apps`).
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
    createdAt: isoTimestamptz("created_at").notNull(),
    updatedAt: isoTimestamptz("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("projects_team_slug_uq").on(t.teamId, t.slug),
    index("projects_owner_idx").on(t.ownerUserId),
  ],
);

/**
 * Per-Project-container access grants — the direct clone of `folder_grants` for
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
 * [Environment](../../types.ts) — a per-Project, first-class ISOLATED deploy
 * target (ADR-0008 Phase 3). Seeded Development/Preview/Production on Project
 * create; renamable and extensible. `kind` is the well-known-role discriminant
 * (`development|preview|production|custom`) that keeps legacy `EnvTarget`
 * resolution and global-env targeting working; `slug` is the host-identity
 * component (a non-Production env's stack becomes `deplo-<appSlug>__<envSlug>`
 * in the pipeline phase — Production keeps the bare slug for zero churn).
 * `git_branch` is this environment's own branch. Plain-text `kind` (no CHECK) per
 * the schema's un-validated-value convention. UNIQUE per project on name and slug.
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
 * Per-(App, Environment) RUNTIME state (ADR-0008 Phase 3b) — the join that
 * lets a service's status / URL / latest deployment fan out along the environment
 * axis without duplicating the whole App row. A row exists once a service is
 * deployed to an environment (the deploy pipeline, wired in a later step, writes
 * it). The stack's deploy KEY is DERIVED, not stored (see
 * [env-deploy-key.ts](../../deploy/env-deploy-key.ts) — the default environment
 * keeps the bare `<slug>`, others get `<slug>__<envSlug>`). Both FKs CASCADE;
 * `latest_deployment_id` `SET NULL`. PK `(app_id, environment_id)`.
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
    // When `status` was last OBSERVED (a probe classified and recorded a result),
    // and the curated reason behind a non-online value. See
    // [Server.statusCheckedAt](../../types.ts): the pair demotes the stored status
    // from a claim to a timestamped observation the UI can qualify.
    statusCheckedAt: isoTimestamptz("status_checked_at"),
    // The throttle LEASE — when a probe was last claimed, advanced whether or not it
    // went on to observe anything. Kept separate from status_checked_at so an
    // inconclusive probe (timeout/skip) never fabricates a fresh observation
    // timestamp. Internal to the health prober; never projected into the DTO.
    statusProbedAt: isoTimestamptz("status_probed_at"),
    statusMessage: text("status_message"),
    // Team access scope. `true` (default) = available to every team — the
    // historical instance-wide behaviour. `false` restricts the server to the
    // teams enumerated in `server_teams`. See [Server.allTeams](../../types.ts).
    allTeams: boolean("all_teams").notNull().default(true),
    // How many deployments this server's agent runs at once (the Coolify
    // `concurrent_builds` analogue). Default 1 = strict per-server serialization:
    // deploys on THIS server run one at a time; deploys on OTHER servers run in
    // parallel. The deploy queue (lib/deploy/deploy-queue.ts) reads it as the
    // per-server slot count; a same-service deploy never overlaps regardless.
    // Editable from Settings → Servers (instance-admin). Clamped >=1 at read.
    deployConcurrency: integer("deploy_concurrency").notNull().default(1),
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
 * server for its apps/databases. `all_teams = true` ignores this table
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
 * [App](../../types.ts) — flat scalar columns only. `slug` UNIQUE *globally*.
 * `folder_id` `ON DELETE SET NULL` (orphan tolerated). `server_id` `RESTRICT`.
 * `latest_deployment_id` `SET NULL`. `repo`/`upload` flattened to columns (small
 * fixed shapes). `expose` is **NOT stored** — derived as `exposes[0]` in the
 * row-assembler (PLAN §2 `apps`, Decision 14). Legacy `source="dockerfile"`
 * is rewritten on backfill by the shared normalizer.
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
    // (additive — ADR-0008). `ON DELETE SET NULL`: deleting a project orphans
    // its apps to the top level.
    projectId: text("project_id").references(() => projects.id, {
      onDelete: "set null",
    }),
    // The Environment (of `project_id`'s Project) this service LIVES in — the
    // membership axis of the advanced-folder model (ADR-0009): each environment
    // of a project holds its OWN apps, like a sub-folder. NULL outside a
    // project. The data layer keeps the pair consistent (environment_id set ⇒
    // project_id is that environment's project; entering a project defaults to
    // its default environment). `SET NULL` is only the FK backstop — deleting an
    // environment re-parents its apps to the project default first.
    environmentId: text("environment_id").references(() => environments.id, {
      onDelete: "set null",
    }),
    serverId: text("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "restrict" }),
    // Set on a server MOVE when the OLD server still holds the service's data
    // (a running stack): it names the source host the NEXT successful deploy on the
    // new server must copy the data volumes + files dir FROM (host-to-host, via the
    // agent ExportVolume/ImportVolume + ExportFiles/ImportFiles RPCs). The deploy
    // clears it once the copy + old-host teardown complete. `SET NULL` if that old
    // server is ever deleted (the source is gone → nothing to copy, drop the marker
    // rather than block the delete). Null in the common case (no pending migration).
    migrateFromServerId: text("migrate_from_server_id").references(
      () => servers.id,
      { onDelete: "set null" },
    ),
    logo: text("logo"),
    source: text("source").notNull(),
    // Flattened GitRepo (NULL columns when there is no repo).
    repoProvider: text("repo_provider"),
    repoUrl: text("repo_url"),
    repoRepo: text("repo_repo"),
    repoBranch: text("repo_branch"),
    repoInstallationId: text("repo_installation_id"),
    // Git deploy options (also flattened GitRepo fields; defaults when no repo).
    // `repo_trigger_type` — which git event auto-deploys: "push" (to repo_branch)
    // or "tag" (any new tag). NULL ⇒ "push" (the historical behaviour). Read by
    // the GitHub webhook to gate a delivery.
    repoTriggerType: text("repo_trigger_type"),
    // `repo_watch_paths` — newline-separated path globs; an auto-deploy only fires
    // when a pushed commit changed a file matching one. NULL/empty ⇒ any change.
    repoWatchPaths: text("repo_watch_paths"),
    // `repo_submodules` — clone the repo's git submodules at build time.
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
    // Per-app resource limits (flattened ResourceLimits, like repo_*/upload_*).
    // Every column NULLABLE with NO default: NULL ⇒ that dimension is UNCAPPED,
    // and an all-NULL row ⇒ `resources` assembles to null (no limits set), so an
    // app that never opened the Resources page renders a byte-identical stack.
    // These are applied at deploy time as `docker compose up` container keys
    // (mem_limit/cpus/pids_limit/…) — see lib/deploy/resources.ts. Memory sizes
    // are stored in MEBIBYTES, disk in GIBIBYTES, and CPU in MILLI-CPUs (1000 =
    // one core) so every value is a clean integer (no float column).
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
    uniqueIndex("apps_slug_uq").on(t.slug),
    index("apps_team_idx").on(t.teamId),
    index("apps_folder_idx").on(t.folderId),
    index("apps_project_idx").on(t.projectId),
    index("apps_environment_idx").on(t.environmentId),
  ],
);

/**
 * [BuildConfig](../../types.ts) → 1-to-1 child (was `apps.build`).
 * `project_id` PK + FK CASCADE. `build_method` plain text, NO CHECK (legacy
 * values are coerced, never rejected). `runtime_version` (legacy `nodeVersion`
 * remapped by `normalizeBuildConfig` at backfill). The backfill MUST run the
 * read-time normalizer first so the NOT NULL columns hold (PLAN §2).
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
 * this row while the parent `app_build` columns merge field-by-field (PLAN §2
 * Decision 15). All columns nullable — every settings field is optional.
 */
export const appBuildMethodSettings = pgTable(
  "app_build_method_settings",
  {
    appId: text("app_id")
      .primaryKey()
      .references(() => apps.id, { onDelete: "cascade" }),
    dockerfilePath: text("dockerfile_path"),
    dockerContextPath: text("docker_context_path"),
    dockerBuildStage: text("docker_build_stage"),
    railpackVersion: text("railpack_version"),
    nixpacksPublishDirectory: text("nixpacks_publish_directory"),
    staticSinglePageApp: boolean("static_single_page_app"),
  },
);

/**
 * [VolumeMount](../../types.ts) → ordered child. `type` NULLABLE (the
 * named/`host`/`service` discriminant; absent ⇒ "named"). Backfill runs
 * `normalizeVolumes` first (drops mountless entries) so the NOT NULL child
 * columns hold (PLAN §2 `app_volumes`).
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
    projectPath: text("project_path"),
    hostPath: text("host_path"),
    mountPath: text("mount_path").notNull(),
    readOnly: boolean("read_only").notNull(),
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
 * [Deployment](../../types.ts) — fully flat. `seq bigint identity` (PLAN §5) so
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
    // Denormalized owning server (mirrors apps.server_id at insert time). The
    // deploy queue drains per server, so it needs the owning host on the row
    // without a apps join on every finish/boot scan. Nullable: backfilled for
    // rows that predate the queue; every new deploy sets it. NOT a FK — a
    // deployment is a historical record that must survive its server's deletion
    // (apps.server_id is RESTRICT, so a live service can't lose its server).
    serverId: text("server_id"),
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
    createdAt: isoTimestamptz("created_at").notNull(),
  },
  (t) => [
    index("deployments_app_created_idx").on(
      t.appId,
      t.createdAt.desc(),
      t.seq.desc(),
    ),
    // The deploy queue's hot path: pick the OLDEST queued deploy for a server.
    // Partial (queued-only) so it indexes just the live backlog, not the whole
    // deploy history; ascending (createdAt, seq) matches the drain's oldest-first
    // ORDER BY.
    index("deployments_queued_server_idx")
      .on(t.serverId, t.createdAt, t.seq)
      .where(sql`${t.status} = 'queued'`),
  ],
);

/**
 * The `logs: Record<ID, LogLine[]>` map → child table (PLAN §2
 * `deployment_logs`). Map key → `deployment_id` FK; each `LogLine` → one row.
 * `id bigint identity` PK reproduces `Array.push` order; `(deployment_id, id)`
 * index. `level` is the `deployment_log_level` pgEnum. Written via a batched
 * buffer at the app-graph cut-set, NOT per-line (PLAN §6 Decision 18).
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
 *
 * Authorship (`created_by_user_id` / `updated_by_user_id`) is METADATA, never a
 * value: it is safe to project into a DTO while `value_enc` stays write-only.
 * Nullable + `ON DELETE SET NULL` — NULL means the author was deleted, or the row
 * predates authorship tracking (0029 deliberately does not backfill), and the UI
 * renders "—".
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
 * [GlobalEnvVar](../../types.ts) (instance scope) — a variable injected into
 * EVERY service of EVERY team (an instance-wide default), managed by an instance
 * admin. No team scope. `UNIQUE(key)`; `targets` → junction. The LOWEST deploy
 * precedence — any more-specific scope (team-global, service, shared) overrides
 * it. See lib/deploy/env-resolve.ts.
 *
 * Authorship (`created_by_user_id` / `updated_by_user_id`) is METADATA, never a
 * value — exposable in a DTO while `value_enc` stays write-only. Nullable + `ON
 * DELETE SET NULL`: NULL = the instance admin who wrote it was deleted, or the
 * row predates authorship tracking (0029 does not backfill) → the UI renders "—".
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
 * [BasicAuthUser](../../types.ts) — an HTTP Basic Auth credential that gates
 * EVERY domain of a service. When a service has any of these, the renderers
 * inject a generated Traefik `basicauth` middleware (built from these users) at
 * the head of every router's middleware chain, so all the service's hostnames
 * sit behind the login prompt. `password_enc` is a REVERSIBLE secret (AES-GCM,
 * like `env_vars.value_enc`) so the htpasswd
 * line can be re-derived on every stack render; it is read back only through the
 * `manage_domains`-gated reveal (a shared login has to be handed to a human, so
 * unlike an app secret it is readable by the people who may change it).
 * `UNIQUE(project_id, username)` — one credential per name.
 *
 * Authorship (`created_by_user_id` / `updated_by_user_id`) is METADATA, never a
 * value — exposable in a DTO while `password_enc` stays out of it. Same shape and
 * same reasoning as the variable tables (migration 0029): nullable, `ON DELETE
 * SET NULL`, and NOT backfilled — a credential written before migration 0045
 * renders "—" rather than naming a user who may never have touched it.
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
    uniqueIndex("app_basic_auth_users_app_username_uq").on(
      t.appId,
      t.username,
    ),
    index("app_basic_auth_users_app_idx").on(t.appId),
  ],
);

/* ================================================================== */
/* Ordering junctions (after apps/folders exist)                  */
/* ================================================================== */

/**
 * Team-wide service display order (was `teams.project_order` jsonb ID[]). PK
 * `(team_id, project_id)`; `ON DELETE CASCADE` on both FKs makes the stale-id
 * self-healing a DB invariant — a dead id can no longer sit in the order (PLAN §1
 * "Ordering junctions", §2 `team_app_order`).
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
 * Team-wide Project-CONTAINER display order (ADR-0008) — the direct analogue of
 * `team_folder_order`/`team_app_order` for the new top-level container. PK
 * `(team_id, project_id)`, both FKs CASCADE so a dead id can't sit in the order.
 * The name `team_project_order` is reclaimed after 0015 renamed the old
 * service-order junction to `team_app_order`.
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
    // Per-database resource limits — the exact flattened ResourceLimits shape and
    // units used on `apps` above (NULL ⇒ uncapped, all-NULL ⇒ `resources: null`;
    // MiB / GiB / milli-CPUs). Applied to the rendered stack on the next
    // provision/reroute via lib/deploy/resources.ts, same as apps.
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
    // Expert overrides, both applied at the next render/reroute. `custom_image`
    // is a full image ref replacing DB_IMAGES[type](version) (version becomes
    // inert while set); `custom_command` REPLACES the default command verbatim —
    // for redis that default carries `--requirepass`, so the UI warns about it.
    customImage: text("custom_image"),
    customCommand: text("custom_command"),
    sizeMb: bigint("size_mb", { mode: "number" }).notNull(),
    createdAt: isoTimestamptz("created_at").notNull(),
  },
  (t) => [uniqueIndex("databases_team_name_uq").on(t.teamId, t.name)],
);

/**
 * Team-wide database display order for the Storage grid — the direct analogue of
 * `team_app_order` for the databases list. PK `(team_id, database_id)`, both FKs
 * CASCADE so a deleted database can't leave a dead id in the order (the
 * self-healing is a DB invariant). Declared AFTER `databases` so the FK needs no
 * forward-reference thunk.
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
    appId: text("app_id").references(() => apps.id, {
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
      sql`(${t.targetKind} = 'database' and ${t.databaseId} is not null and ${t.appId} is null)
          or (${t.targetKind} = 'app' and ${t.appId} is not null and ${t.databaseId} is null)`,
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
    appId: text("app_id").references(() => apps.id, {
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
    // FK columns are ON DELETE SET NULL — index them so a delete's cascade is a
    // lookup, not a full-table scan (migration 0042).
    index("backup_runs_app_idx").on(t.appId),
    index("backup_runs_database_idx").on(t.databaseId),
    index("backup_runs_destination_idx").on(t.destinationId),
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
 *
 * `actor_user_id` is the identity BEHIND that free text, and only when the actor
 * was a human: authorship is metadata, so the log can render a real user. Like
 * `actor`, it is deliberately NOT an FK, and for the same reason: this is an
 * append-only AUDIT trail, so `ON DELETE SET NULL` would REWRITE history the day a
 * user is deleted — precisely what the log must never do. (It is also the one table
 * here that grows without bound, and `ADD CONSTRAINT` takes an ACCESS EXCLUSIVE lock
 * plus a validating scan — at boot, since migrations auto-apply in
 * `instrumentation.ts`.) The raw id is kept forever; an id that no longer resolves
 * renders as "—" and the `actor` name survives regardless. Nullable — a non-human
 * actor ("system"/"github") must never be attributed to anyone, and rows predating
 * tracking (0029 does not backfill) stay NULL.
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
    // app_id is ON DELETE SET NULL — index it so deleting an app doesn't scan the
    // whole activity history (migration 0042).
    index("activities_app_idx").on(t.appId),
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
 * [InstalledPlugin](../../types.ts). `UNIQUE(team_id, catalog_id)` + `UNIQUE(slug)`.
 * `(team_id, created_at DESC)` index. `status`/`url` deliberately NOT stored
 * (computed). Backfill derives the `slug` for legacy empty-slug rows. A LEAF
 * collection (cut-set (a)) (PLAN §2).
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
    index("installed_plugins_team_created_idx").on(t.teamId, t.createdAt.desc()),
  ],
);

/* ================================================================== */
/* Integrations aggregate                                             */
/* ================================================================== */

/* ================================================================== */
/* Unified shared variables (ADR-0010)                                */
/* ================================================================== */

// NOTE: the shared-env GROUP model (`shared_env_groups` + `shared_env_group_vars`
// / `_apps` / `_targets`) was flattened into the individual `shared_env_vars`
// model below. Migration 0027 explodes each group var-key into a per-app-link
// shared var (preserving the attached-app set and precedence) and 0028 drops the
// group tables.

/**
 * [SharedVar](../../types.ts) — ONE individual shared variable owned by a team,
 * the unified replacement for shared-env groups, environment-scoped vars, and
 * team-global vars (ADR-0010). It reaches an app through any of three sharing
 * MODES plus a per-app link:
 *  - `team_wide = true` — every app in the team.
 *  - `shared_env_var_environments` — apps whose `apps.environment_id` ∈ the set.
 *  - `shared_env_var_projects` — apps whose `apps.project_id` ∈ the set (whitelist).
 *  - `shared_env_var_apps` — an explicit per-app link attached from the app UI.
 * `shared_env_var_targets` is the orthogonal runtime axis (production/preview),
 * defaulting to both.
 *
 * There is deliberately **NO** unique on `(team_id, key)`: a key legitimately
 * repeats with different values across scopes (e.g. `DATABASE_URL` scoped to two
 * environments = two rows). Same-key collisions resolve by deploy precedence, not
 * a constraint — see lib/deploy/env-resolve.ts. The "≥1 mode" rule is enforced in
 * the data layer (a CHECK cannot span junction existence).
 *
 * Authorship (`created_by_user_id` / `updated_by_user_id`) is METADATA, never a
 * value — exposable in a DTO while `value_enc` stays write-only. Nullable + `ON
 * DELETE SET NULL`: NULL = the author was deleted, or the row predates authorship
 * tracking — including every var the 0027 backfill exploded out of the legacy
 * groups, which 0029 deliberately does not attribute to anyone. The UI renders "—".
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

/** The 4th mechanism — an explicit per-app link attached from the app UI. */
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

/* ================================================================== */
/* Docker cleanup                                                      */
/* ================================================================== */

/**
 * The Docker-cleanup POLICY — a SINGLETON row (`id` is a fixed `'default'`), not a
 * row per server. Reclaiming Docker disk is a property of the fleet, not of one
 * host: an operator sets "daily at 04:00, keep 3 images, drop caches older than a
 * week" once, and every server inherits it. A host that must be left alone opts OUT
 * via {@link dockerCleanupExcludedServers} — an exclusion list, not N schedules, so
 * there is exactly ONE schedule to reason about and adding a server cannot silently
 * leave it un-swept.
 *
 * No `team_id`: servers are the one shared cross-team resource, so this is
 * instance-wide infra state like `servers.deploy_concurrency`. The singleton PK is a
 * literal so `INSERT … ON CONFLICT (id) DO UPDATE` is the whole write path and two
 * concurrent saves can never mint two policies. A MISSING row is legal and means
 * "cleanup has never been configured" — the data layer answers with defaults
 * (disabled), the way a missing `notification_settings` row does.
 *
 * There is deliberately NO denormalized `last_run_at` / `last_status` here (the
 * `backups` table carries them because its schedule is 1:1 with its runs). One policy
 * fans out to N servers, so "when did THIS host last run, and is one in flight?" is a
 * per-server question, answered from {@link dockerCleanupRuns} — the source of truth,
 * which cannot drift from itself.
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
   * filter. App images ignore it on agents ≥ 1.12 — count-based retention
   * (`keep_images_per_app`) is what bounds them, because an age floor on a
   * fast-redeploying host means nothing ever qualifies and the disk saturates
   * (migration 0040 moved the old 168h default to 24h for exactly that reason).
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
 * The scopes the policy is allowed to reclaim — a LIST, so a junction table, never a
 * JSONB array. `scope` is one of the four wire ids the agent's `CleanupScope` enum
 * defines: `build_cache` · `dangling_images` · `orphan_buildkit_cache` ·
 * `unused_app_images`. That set is an ALLOW-LIST and is closed: container, volume,
 * network and `system` prune do not exist as scopes and must never be added, because
 * on a Deplo host a STOPPED app is a live app (StopStack = `compose stop`, the
 * container must survive) and a dangling volume may hold user data.
 *
 * Plain `text` like `backup_runs.status`, not a `pgEnum`: the enforcement that
 * matters is the agent's own allow-list (the only thing that can delete anything) plus
 * the data layer's validation on write — a DB CHECK would add a second place for the
 * set to drift from the proto enum without being the boundary that protects the host.
 * A scope the agent does not recognise is refused there, not obeyed.
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
 * Servers the SCHEDULED sweep skips — the policy's opt-out list. A row here means
 * "the nightly job leaves this host alone"; a MANUAL "clean up now" ignores the list
 * entirely, because an operator standing in front of the button has already made the
 * decision this table exists to encode.
 *
 * Membership is the whole record — presence is the fact, so there is no `enabled`
 * flag to contradict it. CASCADE on the server: an excluded server that is removed
 * takes its exclusion with it, so a later server minted with a recycled id could not
 * inherit a stale opt-out.
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
 * One cleanup RUN on one server — the history, and a SEPARATE table from the policy
 * (the `backup_runs` precedent). One scheduled tick fans out to one row per server.
 *
 * The row is written as `status:'running'` BEFORE the agent is dialled, so "could not
 * reach the agent" still lands as a failed run: history never lies about a sweep that
 * was attempted. `seq bigint identity` breaks same-millisecond ties so every listing
 * is a total order (`ORDER BY started_at DESC, seq DESC`, PLAN §5).
 *
 * `server_id` is `SET NULL` and `server_name` is DENORMALIZED next to it on purpose:
 * the history outlives the server. Once a host is removed, "we reclaimed 9 GB on
 * eu-main-1 last Tuesday" must still read as that sentence, not as a dangling id.
 *
 * `reclaimed_bytes` MUST be `bigint` (the `backup_runs.size_bytes` rule) — a full
 * build cache exceeds 2 GB routinely and would overflow `integer`.
 *
 * The partial index on `status='running'` serves both the boot reconcile (settle rows
 * stranded by a control-plane restart) and the scheduler's never-stack-runs check.
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
    /** The human's name, or `"Scheduler"` for a tick — free text, like `activities.actor`. */
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
 * The per-scope breakdown of one run — a LIST, so a child table. `(run_id, scope)` is
 * the PK: a scope reports exactly once per run.
 *
 * `skipped` is NOT a failure and neither is `error`: the agent declines a scope it
 * cannot prove is safe (e.g. it could not build the container-reference reverse index,
 * so it refused to guess) and reports the per-scope failure, while the run as a whole
 * still succeeds. Keeping both here is what lets the UI say *which* scope reclaimed
 * nothing and *why*, instead of a single opaque total.
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
 * Monitoring settings — a SINGLETON row like {@link dockerCleanupPolicy} (`id` is a
 * fixed `'default'`), and instance-wide for the same reason: servers are the one
 * shared cross-team resource, so whether the control plane keeps their metrics
 * history is a property of the fleet, not of a team.
 *
 * The one knob today is `save_metrics`: when true, the control plane keeps a
 * short rolling metrics HISTORY per server **in process memory** (see
 * lib/monitoring/history.ts) — fed by a background collector plus every live
 * dashboard poll — so the Monitoring charts survive a page reload instead of
 * starting empty. The samples themselves are deliberately NOT stored in Postgres:
 * a per-second time series is ring-buffer data, not relational state, and the
 * window is minutes, not months.
 *
 * A MISSING row is legal and means "never configured" — the data layer answers
 * with the default (**enabled**: keeping ~15 minutes of numbers in RAM costs
 * ~0.5 MB per server and makes the page work the way a non-expert expects).
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
 * Instance settings — a SINGLETON row (`id` fixed at `'default'`), the shape of
 * {@link monitoringSettings} / {@link dockerCleanupPolicy}. Today it carries one
 * thing: who owns this Deplo instance.
 *
 * `owner_user_id` is the **instance owner** — the instance-level twin of
 * {@link teams.founderUserId}, and the answer to a real lockout: `is_instance_admin`
 * is a flat boolean any admin may clear on any OTHER admin, so before this row
 * existed a single admin you promoted could demote every peer (the last-admin
 * invariant is satisfied by *themselves*), suspend them, reset their password, and
 * own the instance — with no user-deletion path and no self-service password reset
 * to climb back through. The first account had no protection whatsoever.
 *
 * The owner is therefore immutable to everyone but the owner: no other admin may
 * demote, suspend or reset them, and they cannot drop their own admin flag either
 * (same rule as the team founder, who cannot be demoted even by themselves). It is
 * not a dead end — the crown TRANSFERS, but only by the hand wearing it.
 *
 * NULLABLE, and the FK deliberately has **no `ON DELETE` action** (unlike
 * `teams.founder_user_id`, which is `SET NULL`): there is no user-deletion path in
 * the product, and if one is ever added, orphaning the crown should be a loud FK
 * error rather than a silent slide back into the unowned-instance state this row
 * exists to end. A missing row / NULL owner means "unowned" — legal, and what an
 * instance upgraded from before this migration looks like if it somehow had no
 * admin to backfill from. Recovery for a locked-out owner is the host-side CLI
 * (`bun run recover`), which is why losing the row is survivable rather than fatal.
 */
export const instanceSettings = pgTable("instance_settings", {
  /** Always `'default'`. The row is a singleton; the PK exists to enforce that. */
  id: text("id").primaryKey().default("default"),
  /** The instance owner — see the table comment. NULL means "unowned". */
  ownerUserId: text("owner_user_id").references(() => users.id),
  updatedAt: isoTimestamptz("updated_at").notNull(),
});
