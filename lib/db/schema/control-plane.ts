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
 * [User](../../types.ts). Flat. The 4 optional instance-wide booleans become NOT
 * NULL DEFAULT false. `UNIQUE(lower(email))` (the app does case-insensitive checks)
 * and `UNIQUE(username)` are enforced by indexes below; no FKs out.
 *
 * Since migration 0055 this table is ALSO Better Auth's `user` model (remapped via
 * `user: { modelName: "users" }`), which is why `email_verified` / `image` /
 * `updated_at` / `two_factor_enabled` sit here alongside deplo's own columns. The
 * password moved out entirely: `account.password` is now the only stored credential.
 * Better Auth never INSERTs here — `username` / `role` / `avatar_color` are NOT NULL
 * columns it knows nothing about, so `disableSignUp: true` keeps account creation in
 * `createAccountWithTeam`, which writes the matching `account` row itself.
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
    // Better Auth's `user` model requires these three. deplo has no email
    // verification flow, so `email_verified` is true for everyone and `image` is
    // unused (avatars are `avatar_color`); they exist to satisfy the model.
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
    // Team-wide 2FA policy: when true, a member without a verified TOTP factor
    // resolves NO capabilities in this team, over the UI and the bearer API alike
    // (lib/membership.ts). Off by default; enabling it is refused unless the actor
    // has 2FA themselves, so it can never lock its own author out.
    requireTwoFactor: boolean("require_two_factor").notNull().default(false),
    // Whether this team's API tokens may drive it over MCP (`/api/mcp`). Off ⇒
    // the endpoint refuses the whole request, before any tool runs.
    //
    // OFF by default for a NEW team, on for every team that already had it: a
    // token is required either way, so this was never the thing making the
    // endpoint safe — but "may an AI agent act in this company's infrastructure"
    // is a decision somebody should make rather than inherit, and a kill switch
    // that ships open is one nobody knows they have. Turning it on is one click
    // in Settings → MCP Server, on the same screen that explains it.
    mcpEnabled: boolean("mcp_enabled").notNull().default(false),
    // When the team's default backup destination was seeded (lib/data/destinations.ts
    // `ensureDefaultDestination`). A ONE-SHOT marker, not a timestamp anyone reads:
    // seeding on "the team has no destinations" instead made the default
    // undeletable — removing it simply re-created it on the next page load.
    backupDefaultSeededAt: isoTimestamptz("backup_default_seeded_at"),
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
 * [deploy-key.ts](../../deploy/deploy-key.ts) — the default environment
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
 * Per-App access grants — the third and most specific rung of the same ladder as
 * `folder_grants` / `project_grants`: one row per (app, user, capability). An App
 * has no owner column and no privacy story of its own (every member of the team
 * can already SEE every app), so unlike a folder grant this one never makes
 * anything visible — it only says what the user may DO to that one app, and it
 * beats the folder, project and membership sets that would otherwise apply
 * (ADR-0016). Both FKs CASCADE; `app_grants_user_idx` powers the per-user lookup.
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
 * The ENVIRONMENT rung of the same ladder. An app lives in exactly one
 * environment of its project (ADR-0009's membership axis), and until this table
 * the resolver walked app → folders → project and stepped straight over it — so
 * "deploy to staging and nowhere near production" was inexpressible even though
 * every app carries the answer.
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
 * A named, per-team capability set a member can be assigned — the team's Roles
 * (Settings → Team → Roles). Every team owns its own rows: three built-ins
 * (`builtin_key` 'owner' | 'member' | 'viewer', seeded lazily by
 * `ensureTeamRoles`) plus any number of custom roles (`builtin_key` NULL) with a
 * name and capability set the team's admins choose.
 *
 * The role is the SOURCE of a member's capabilities, not a second copy of them:
 * `membership_capabilities` stays the effective set every authorization check
 * reads, and editing a role re-writes those rows for its members in the same
 * transaction. A membership whose `role_id` is NULL is a hand-picked ("Custom")
 * set — the pre-roles shape, still legal and still enforced.
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
    // Policy, NOT a capability: capabilities are a closed set of 8 that answer
    // "may they do X", while this answers "under what condition does any of it
    // count". Holders of this role resolve no capabilities until they enroll a
    // TOTP factor — same gate as `teams.require_two_factor`, narrower blast radius.
    requireTwoFactor: boolean("require_two_factor").notNull().default(false),
    // The INTENT to reach only part of the team, stored apart from the junctions
    // below for the reason `api_tokens.scoped` exists: deleting a project in the
    // scope cascades its row away, and an emptied scope with no flag would read
    // as "no scope" and silently WIDEN the role to everything. Scoped with zero
    // rows means "reaches nothing".
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
 *
 * Three junctions rather than one polymorphic `(node_kind, node_id)` table, for
 * the same two reasons the API token's scope is four: a Postgres PRIMARY KEY
 * cannot contain a nullable column, and a real FK per kind is what makes the
 * cascade the whole cleanup story. Deleting a project empties the scope by
 * itself, which is exactly what `scoped` above is there to keep honest.
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
    // The member's RANK: 'owner' outranks everyone (only an owner may act on
    // another owner or hand out the owner role). Kept as a column — assigning a
    // role writes it from that role's `builtin_key` (a custom role ranks as
    // 'member') — so every rank guard stays a plain read of this row.
    role: text("role").notNull(),
    // The assigned {@link teamRoles} row. NULL ⇒ a hand-picked "Custom"
    // capability set that belongs to no role. `ON DELETE RESTRICT`: a role with
    // members can't be deleted out from under them (the data layer refuses first,
    // with a message naming the count).
    roleId: text("role_id").references(() => teamRoles.id, {
      onDelete: "restrict",
    }),
    // Whether this member's access is set per NODE on top of the role — the
    // admin's MODE choice, not a derived fact. The role still supplies the base
    // set (so editing the role still reaches them); the node grants in
    // `app_grants` / `folder_grants` / `project_grants` override it inside the
    // nodes they name (ADR-0016). Kept as a column because node rows cascade
    // away: "granular with nothing left ticked" must not read as Role mode.
    granular: boolean("granular").notNull().default(false),
    // This member's capability set is THEIR OWN: the member page saved something
    // other than what their role grants, so `syncMembersOfRole` leaves them
    // alone. Without it a role rename handed back every permission an admin had
    // taken away from one person. False for everyone who simply follows a role,
    // which is almost everyone.
    customCapabilities: boolean("custom_capabilities").notNull().default(false),
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
    // The same token, encrypted, so the admin can copy the link again instead of
    // minting a second one because they lost the first. The HASH is what the
    // register page looks up (constant-time, and the only thing consulted when a
    // link is consumed); this is a read-back path for the person who created it,
    // gated on instance-admin like everything else about a link. NULL on links
    // minted before migration 0048 — those can only be revoked and re-minted.
    tokenEnc: text("token_enc"),
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
    // A VPS bought purely to HOLD BACKUPS: the agent is installed, Docker is
    // not, and nothing is ever deployed here. Set by the storage-only installer.
    //
    // It exists because readiness and health are otherwise right to be alarmed:
    // `docker.available` is a `fail`-severity check and `classifyServerHealth`
    // returns `warning` without Docker, so a storage box would sit permanently
    // red for doing exactly what it was bought for. With this flag those two
    // checks skip, and the server drops out of every deploy-target picker while
    // staying eligible as a backup destination.
    storageOnly: boolean("storage_only").notNull().default(false),
    // A server bought purely to COMPILE: Docker is installed, Traefik is not, and
    // no app of any team runs here. It builds images for the hosts that do, which
    // then receive them over the ExportImage/ImportImage relay.
    //
    // The sibling of `storage_only`, and exclusive with it (a CHECK enforces that):
    // one specialises away the workload, the other specialises away Docker itself.
    // Two flags rather than a `role` enum because both are absent for the ordinary
    // server that does everything, which is what almost every row is.
    //
    // What it changes: the host drops out of every deploy-target picker (apps and
    // databases alike), and the Traefik readiness check becomes a `skip` instead of
    // a warning - a build server has no proxy BY DESIGN and should not read as
    // half-configured for it. Docker is still required; that check is unchanged.
    //
    // Reversible from the UI, like every role: the installer's only build-only
    // branch is skipping Traefik, so a role is otherwise purely a control-plane
    // decision. Leaving "everything" is refused while the host still has apps or
    // databases on it. The one true one-way door is physical - a host installed as
    // backups-only has no Docker to build with.
    buildOnly: boolean("build_only").notNull().default(false),
    // This host's CPU architecture ("amd64" | "arm64"), observed from each Hello
    // like `docker_version` and `traefik_enabled` - never asserted at registration.
    // "" means an agent too old to report it, which can never equal another host's
    // arch and so simply keeps this server out of the build-server picker.
    //
    // Persisted, unlike the rest of the Hello capability set, for one reason: the
    // "Build on" picker has to grey out the mismatched hosts, and a picker that
    // dialled every agent to render itself would be a page load per server.
    hostArch: text("host_arch").notNull().default(""),
    // How many deployments this server's agent runs at once.
    // Default 1 = strict per-server serialization:
    // deploys on THIS server run one at a time; deploys on OTHER servers run in
    // parallel. The deploy queue (lib/deploy/deploy-queue.ts) reads it as the
    // per-server slot count; a same-service deploy never overlaps regardless.
    // Editable from Settings → Servers (instance-admin). Clamped >=1 at read.
    deployConcurrency: integer("deploy_concurrency").notNull().default(1),
    // The Traefik web panel: Traefik's own dashboard, published on a domain.
    // NULL domain = off, which is the default and where it stays unless an
    // instance admin opts in from Settings → Servers → Advanced.
    //
    // The three move together. The dashboard lists every router, service and
    // certificate on the host, so publishing one without credentials would put
    // the fleet's routing table on the open internet — `setServerTraefikDashboard`
    // refuses a domain without both a username and a password.
    traefikDashboardDomain: text("traefik_dashboard_domain"),
    traefikDashboardUser: text("traefik_dashboard_user"),
    // Encrypted (AES-256-GCM via DEPLO_SECRET), never projected into a DTO and
    // with no reveal path. Stored rather than write-once because the htpasswd
    // line is re-derived every time the stack file is rewritten: changing the
    // domain must not mean retyping the password.
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
    // Which server BUILDS this app's image, when that is not the one that runs it.
    // NULL is "Automatic": use a build-only server if the fleet has one this team
    // can reach and its arch matches, otherwise build where the app runs - which is
    // what every app did before build servers existed, so NULL is also the honest
    // default for every existing row.
    //
    // "Build on this app's own server" is expressed by pinning that server's id, not
    // by a sentinel: a column of ids that sometimes holds a magic word is the kind of
    // thing that reads fine and then breaks a join. `updateAppSource` carries the pin
    // across a server move, exactly where it already re-hosts the app's domains.
    //
    // `SET NULL`, not RESTRICT: removing a build server must never be blocked by an
    // app that merely preferred it, and falling back to Automatic is always valid.
    buildServerId: text("build_server_id").references(() => servers.id, {
      onDelete: "set null",
    }),
    // When the build server is unreachable, build on this app's own server instead
    // and say so in the deploy log. ON by default: a deploy that ships beats a deploy
    // that fails, and the previous version keeps serving either way.
    //
    // Turned OFF by whoever chose a small deploy server ON PURPOSE - for them a
    // surprise build on the production box is the worse outcome, because it can take
    // the apps already running there down with it.
    buildFallbackLocal: boolean("build_fallback_local").notNull().default(true),
    logo: text("logo"),
    // The JavaScript framework Deplo recognised in this app's own source
    // ("nextjs", "astro", …; see lib/apps/framework-catalog.ts), or NULL when
    // none was found / the build method isn't one of the auto-detecting builders.
    // DERIVED: every deploy re-detects and overwrites it, so it follows the repo
    // instead of drifting from it. Plain text with no CHECK — an id written by a
    // newer catalog must round-trip through an older binary rather than break
    // the row.
    framework: text("framework"),
    // The framework the USER picked when detection got it wrong (same id space).
    // NULL ⇒ trust detection, which is the default and the common case. Kept in
    // its own column precisely so a deploy's re-detection can keep overwriting
    // `framework` without ever clobbering the choice — and so the UI can still
    // say what was detected while showing what the user picked.
    frameworkOverride: text("framework_override"),
    source: text("source").notNull(),
    // Flattened GitRepo (NULL columns when there is no repo).
    repoProvider: text("repo_provider"),
    repoUrl: text("repo_url"),
    repoRepo: text("repo_repo"),
    repoBranch: text("repo_branch"),
    repoInstallationId: text("repo_installation_id"),
    // The `git_connections` row that authenticates this clone, for any host that
    // is NOT GitHub. Mutually exclusive with `repo_installation_id` in practice
    // (one credential per repo), and NULL for a public repo cloned anonymously —
    // which is what every pre-existing `source='git'` app is. No FK, mirroring
    // `repo_installation_id`: deleting a connection clears this column
    // explicitly, so the unlink is a visible write and not a cascade nobody read.
    repoConnectionId: text("repo_connection_id"),
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
    // Deploy hook (migration 0059): the unguessable segment of this app's
    // "deploy now" URL, AES-GCM encrypted because the link has to be readable
    // back, and NULL until someone first opens the hook (minted on demand, so no
    // app carries a live credential it never asked for). The token never gates a
    // deploy on its own — the endpoint also requires an API token as
    // `Authorization: Bearer deplo_…` belonging to a member with `deploy_apps`.
    deployHookTokenEnc: text("deploy_hook_token_enc"),
    // The hook's kill switch, ON by default (it is already bearer-gated).
    deployHookEnabled: boolean("deploy_hook_enabled").notNull().default(true),
    // Extra flags this app adds to the `docker compose up` its server runs
    // (migration 0060) — the RAW string as typed; the deploy edge splits it into
    // argv tokens. NULL/empty ⇒ the untouched command. Flags only: the ones that
    // decide WHICH stack comes up are refused on both sides. See
    // lib/deploy/compose-args.ts.
    composeUpArgs: text("compose_up_args"),
    // How many previous deployments this app can be rolled back to (migration
    // 0094). It is a RETENTION number, not a feature flag: it decides how many of
    // this app's built images survive on its server, so 0 genuinely means "keep
    // nothing to go back to" and the Rollback action disappears. Defaults to 3 -
    // the point of the feature is that a bad deploy is undoable without anyone
    // configuring anything first. The host enforces it exactly, via the per-slug
    // map on DockerCleanupRequest (lib/data/docker-cleanup.ts).
    rollbackKeep: integer("rollback_keep").notNull().default(3),
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
    // Pull request previews (one ephemeral stack per open pull request),
    // flattened like resource_*: NULL ⇒ the platform default, so an app that
    // never opened the setting behaves identically to one that did.
    //
    // OFF by default. A preview is a container on the operator's host; switching
    // that on for every existing GitHub app without being asked is not a default
    // anyone chose. The single Switch lives in Settings → Deployments.
    previewEnabled: boolean("preview_enabled").notNull().default(false),
    // NULL ⇒ a deterministic nip.io host on plain HTTP (zero DNS configuration,
    // and nip.io can never hold a Let's Encrypt certificate — it is ONE
    // registered domain sharing one rate limit across the whole internet). A base
    // like `preview.example.com` needs ONE wildcard DNS record and gives each
    // preview its own HTTP-01 certificate from the existing letsencrypt resolver.
    previewBaseDomain: text("preview_base_domain"),
    // NULL ⇒ PREVIEW_MAX_ACTIVE_DEFAULT. "Keep at most N": at the cap a NEW
    // preview EVICTS the open one with the oldest `last_activity_at` rather than
    // being refused, which is what makes the number mean what it says.
    //
    // The evicted row survives as `status = 'evicted'` and does NOT come back on
    // the next push — only a person clicking Redeploy revives it. That asymmetry
    // is the whole design: without it, three active pull requests under a cap of
    // three would destroy each other on every commit, a full build per cycle.
    previewMaxActive: integer("preview_max_active"),
    // NULL ⇒ PREVIEW_TTL_DAYS_DEFAULT. Idle days before the reaper closes a
    // preview: what makes the cap self-healing, and the safety net for a `closed`
    // webhook that never arrived. Any sync bumps `last_activity_at`, so an active
    // pull request never expires.
    previewTtlDays: integer("preview_ttl_days"),
    // NULL ⇒ "approve". deny | approve | allow. A pull request from a fork is
    // attacker-authored code that would run on the operator's host, so by default
    // it lands in the list as blocked and waits for a member with `deploy`.
    // Even under "allow", a fork preview never receives `secret`-typed variables.
    previewForkPolicy: text("preview_fork_policy"),
    // Where previews run. NULL ⇒ this app's own `server_id`, which is the right
    // default: a preview is only honest if it runs where production runs. The
    // override exists because deplo is multi-server and the competitors are not
    // — pointing pull request builds at a scrap machine keeps them off the box
    // serving production. `SET NULL` so retiring that server silently returns
    // later previews to the app's own server instead of failing to deploy.
    previewServerId: text("preview_server_id").references(() => servers.id, {
      onDelete: "set null",
    }),
    // HTTPS on preview hosts. Only meaningful with `preview_base_domain` set:
    // a nip.io host can never hold a certificate (one registered domain, one
    // Let's Encrypt budget, shared with the whole internet), so the UI keeps the
    // switch off and disabled until a base domain exists. On ⇒ each preview host
    // gets its own HTTP-01 certificate from the existing resolver; off ⇒ plain
    // HTTP, which is also a legitimate choice on a domain you own.
    previewHttps: boolean("preview_https").notNull().default(false),
    // Rebuild a preview when its pull request receives a new commit. Off ⇒ the
    // preview is built once and only a person refreshes it, which is what a team
    // paying per build minute or running a heavy image will want. Deliberately
    // NOT `apps.auto_deploy`: turning off deploy-on-push for PRODUCTION is about
    // release control and says nothing about pull requests.
    previewAutoDeploy: boolean("preview_auto_deploy").notNull().default(true),
    // Container port a preview routes to. NULL ⇒ `app_build.port`, which is what
    // makes a preview faithful to production. Set only when the pull request's
    // branch genuinely listens somewhere else. Minted onto `app_previews.port`
    // at creation, because the renderer reads the preview ROW, not this table.
    previewPort: integer("preview_port"),
    // Build a pull request while it is still a draft. Off by default: a draft is
    // work in progress, and a container for it burns a slot nobody asked for.
    // The manual "Deploy a pull request" action is the per-case escape hatch.
    previewBuildDrafts: boolean("preview_build_drafts").notNull().default(false),
    // Post (and keep updating) the one sticky comment carrying the preview URL.
    // On by default — the comment is where a reviewer actually looks — but it
    // needs `pull_requests: write` on the GitHub App, so an instance that will
    // not grant it can turn the attempt off instead of collecting 403s.
    previewComment: boolean("preview_comment").notNull().default(true),
    // Newline-separated pull request LABELS that gate a preview: a pull request
    // must carry at least one to get one. NULL/empty ⇒ no filter, every pull
    // request qualifies. Same storage shape as `repo_watch_paths` above — a
    // newline list of match strings on the app's git config, split at the edge.
    previewRequiredLabels: text("preview_required_labels"),
    // Cron jobs (scheduled commands run inside this app's container).
    //
    // OFF by default, and the switch is the whole opt-in: a cron job runs
    // arbitrary commands as the container's user with no sandbox, so it is an
    // advanced feature that has to be asked for, not one an existing app wakes
    // up with. Turning it off stops the schedule and keeps the jobs, so it is
    // also the per-app pause button. Unlike the preview settings above there is
    // no second column here - everything else is per-job (`cron_jobs`), because
    // two jobs on one app legitimately want different shells, fuses and timeouts.
    cronEnabled: boolean("cron_enabled").notNull().default(false),
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
    // Who created this app. Authorship METADATA, never authority — every gate
    // stays team/folder-scoped, and this column is read by exactly one flow:
    // deleting a user account (Settings → Users), which offers "also delete the
    // apps they created" as an explicit opt-in. `ON DELETE SET NULL` because the
    // default must be the safe one: removing someone's account can never, by
    // itself, destroy an app the team still runs — that call belongs to the
    // operator ticking the box, not to a cascade.
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    // When someone confirmed this app's deletion (migration 0097). Set BEFORE the
    // teardown, which takes seconds on a healthy host and up to the dial timeout
    // on an unreachable one; the row itself goes when the teardown finishes.
    //
    // While it is set the app is GONE as far as the product is concerned: every
    // gate refuses it, its pages 404, and the Overview renders it dimmed and
    // pulsing instead of a card someone can click into and deploy. That is also
    // what makes the operation crash-safe — a stamp with no process behind it is
    // an unfinished delete, which `resumeAppDeletes` finishes at boot.
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
  // Reuse the owning server's Docker layer cache (and the builder's own cache
  // mounts) between this app's builds — default ON, which is what makes a
  // redeploy of an unchanged app take seconds. OFF ⇒ every build of this app runs
  // `docker build --no-cache` and nixpacks is left on its per-build-dir cache key,
  // so nothing is carried over. Advanced setting; see lib/deploy/build.ts.
  buildCache: boolean("build_cache").notNull().default(true),
  // Armed by "Clear build cache": the NEXT build of this app ignores the cache,
  // then the deploy clears the flag. A one-shot rather than a stored "cleared at"
  // because there is nothing to delete on the host — the cache is per-server and
  // shared, so an app clears its own by refusing to read it once and rewriting it.
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
    // The server this deploy BUILT on, when that was not `server_id`. NULL is the
    // ordinary case and means "built where it runs" - including every row that
    // predates build servers, which is why it needs no backfill.
    //
    // Denormalized and FK-less for the same two reasons `server_id` is: the queue
    // drains on it (the build server's lane is the one that matters, because the
    // build is where the cost is), and a deployment is a historical record that has
    // to survive the deletion of the host it names. It is also the audit answer to
    // "where did this app's source and secrets actually go", which is not a question
    // whose answer may disappear when someone decommissions a builder.
    buildServerId: text("build_server_id"),
    status: text("status").notNull(),
    environment: text("environment").notNull(),
    // The host-side KEY this deploy owns: the container `deplo-<key>`, the stack
    // file `<key>.yml`, the files dir `files/<key>`, the named volumes
    // `deplo-<key>-<name>` and every agent RPC. For a production deploy it IS the
    // app slug (backfilled that way, so every running stack is untouched); for a
    // preview it is `<slug>__pr-<n>` (lib/deploy/deploy-key.ts).
    //
    // Denormalized for the same reasons `server_id` is: the queue drain reads it
    // without an apps join, and it records what was ACTUALLY deployed — it
    // outlives both a slug rename and the preview row itself.
    deployKey: text("deploy_key").notNull(),
    // The preview this deploy belongs to, or NULL for production. `SET NULL`, not
    // cascade: destroying a preview must never delete the build history of what
    // it deployed.
    previewId: text("preview_id").references((): AnyPgColumn => appPreviews.id, {
      onDelete: "set null",
    }),
    // Denormalized pull-request number so the deployments list can still say
    // "PR #42" after the preview row is gone.
    prNumber: integer("pr_number"),
    commitSha: text("commit_sha").notNull(),
    commitMessage: text("commit_message").notNull(),
    commitAuthor: text("commit_author").notNull(),
    branch: text("branch").notNull(),
    url: text("url").notNull(),
    readyAt: isoTimestamptz("ready_at"),
    // When the build actually STARTED — the moment the queue drain claimed this
    // row (`queued` → `building`), i.e. the instant `build_duration_ms` is
    // measured from. Null while the deploy is still queued (and on rows that
    // predate the column): a build that never started has no start to report.
    // Persisted so "Build time" can tick LIVE in the UI and survive a reload —
    // the build job's in-process clock dies with the job, and `created_at` would
    // count the queue wait as build time.
    startedAt: isoTimestamptz("started_at"),
    buildDurationMs: bigint("build_duration_ms", { mode: "number" }),
    // This deploy must REPLACE the running containers even when the rendered
    // stack is unchanged (`docker compose up --force-recreate`). Set only by the
    // explicit "Rebuild container" action — `up -d` is a no-op when compose's
    // config hash matches, which for a compose stack or a prebuilt image meant
    // Rebuild reported success without ever replacing the container. Every other
    // deploy leaves it false so an unchanged reroute still causes no restart.
    forceRecreate: boolean("force_recreate").notNull().default(false),
    // The image tag this deploy actually rendered into its stack - the string the
    // agent built and `compose up` ran (migration 0094). Written ONLY by the arms
    // Deplo builds (git, upload), where it is
    // `deplo/<deploy_key>:<first 12 of this row's id>` and the image lives on the
    // owning host. NULL everywhere else: a compose stack has no single image, and a
    // prebuilt `docker-image` source is a mutable registry tag with nothing pinned
    // behind it. So NOT NULL reads as "there is an image of ours to go back to",
    // which is exactly what makes this row a rollback target.
    //
    // Recorded rather than derived on demand: the tag is derivable from the id, but
    // only for a deploy that actually built one - an app that used to be a
    // `docker-image` source would answer with a `deplo/` tag nobody ever minted.
    imageRef: text("image_ref"),
    // Set when this deploy is a ROLLBACK: the id of the deployment whose image it
    // re-ran. Plain text with NO foreign key, like `server_id` - history has to
    // survive the deletion of what it points at.
    //
    // It is also load-bearing for retention: a rollback row reuses an existing
    // image rather than building one, so it must not consume a slot when ranking
    // which builds are still on the host. NULL ⇒ "this deploy built its own image".
    rollbackOf: text("rollback_of"),
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
 * A **pull request preview**: an ephemeral stack built from one open pull
 * request and torn down when it closes. One row per (App, pull request).
 *
 * It is neither an App nor an Environment. It renders from the App's build
 * config but owns its own deploy key `<slug>__pr-<n>`, its own container, files
 * dir, named volumes and hostname — see [deploy-key](../../deploy/deploy-key.ts).
 *
 * TWO STATE COLUMNS, on purpose:
 *  - `state`  is the LIFECYCLE (`open` | `closed`), owned by the pull request.
 *  - `status` is the RUNTIME (`blocked|queued|building|active|error|idle|
 *    evicted`), the per-preview twin of `apps.status`. It exists so a preview
 *    build can never repaint the production App's badge.
 *
 * `evicted` is the cap's doing, not the pull request's: the app was at
 * `preview_max_active` and this was the least recently active open preview, so
 * its stack went away to make room. `state` stays `open` — the pull request is
 * still open, and the row still holds the deploy key and host it will reuse if
 * somebody clicks Redeploy. Nothing revives it automatically, which is what
 * stops two pull requests at the cap from destroying each other on every push.
 *
 * The row SURVIVES the close (`state = 'closed'`), which is what makes teardown
 * idempotent AND retryable: `torn_down_at IS NULL` is the reaper's retry
 * predicate and stamping it is the only proof the stack is really gone. Deleting
 * the row on close would mean an agent that happened to be unreachable at that
 * moment leaks a container and a volume set nothing points at any more.
 *
 * `deploy_key` and `host` are minted ONCE at open and never recomputed — the URL
 * is commented on the pull request, so regenerating either would strand a link
 * somebody is testing.
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
    // Who unblocked a fork preview, and at which commit. Approval is per pull
    // request, not per commit (a click per push is unusable, and it is how
    // GitHub's own "Approve and run" behaves) — `approved_sha` is the audit
    // record of what was reviewed, shown in the UI, not a gate that re-arms.
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
     * The container port this preview's router forwards to, minted from the
     * app's `preview_port` (or its build port) when the preview is created.
     *
     * Denormalized for the same reason `cert_provider` is: `runDeployment`
     * re-reads the PREVIEW ROW, never the app's settings, so anything the
     * renderer needs has to live here — and a setting changed mid-flight must
     * not silently repoint a preview somebody is already testing.
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
 *
 * Deleting an App tore its stack down best-effort and dropped the row anyway, so
 * an unreachable host kept the containers and the volumes and the only trace was
 * an Activity line asking a human to go clean up. One row here IS the intent,
 * written before the agent is dialed, and retried by the drain in
 * `lib/data/teardown-queue.ts` until the host proves the stack is gone.
 *
 * {@link pendingTeardowns.projectLabel} is the `deplo.project` label value (an
 * App id, a preview's own id, a database id) and it is what makes a LATE retry
 * safe: `apps_slug_uq` is global, so a deleted slug can be taken by a new app on
 * the same server, and a retry keyed on the deploy key alone would tear down that
 * app instead. The identity is the id, never the slug.
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
    teamId: text("team_id").references(() => teams.id, { onDelete: "set null" }),
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

/**
 * Preview-only environment variable OVERRIDES (advanced).
 *
 * A preview inherits the App's variables verbatim by default — the Vercel
 * behaviour, and the one that needs no configuration. This table is the escape
 * hatch for the one case that genuinely matters: pointing a preview at a scratch
 * database instead of the production one.
 *
 * It is a separate table rather than a second `env_vars` row because
 * `env_vars_app_key_uq` is `UNIQUE(app_id, key)` — two values for one key are
 * not representable there. It folds LAST in
 * [env-resolve](../../deploy/env-resolve.ts), above the app's own vars AND above
 * linked shared vars, and only for the `preview` target: an override is the most
 * specific statement a user can make, and if a team-wide shared variable
 * outranked it the feature could not do the one thing it exists for.
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
    // DISPLAY name only — editable in Settings → General, like an App's. The
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
 * [BackupDestination](../../types.ts) — where backup artifacts are kept. TWO
 * kinds behind one `kind` discriminator, because `backups.destination_id` and
 * `backup_runs.destination_id` must keep pointing at one table:
 *
 *  - `s3` — a bucket. `provider`/`endpoint`/`region`/`bucket` +
 *    `access_key_enc`/`secret_key_enc` (the secret key is never even
 *    masked-returned).
 *  - `server` — a directory on a server in the fleet. `server_id` + `path`
 *    (NULL = the agent's own managed store) + an age keypair.
 *
 * The kind's shape is a DB-level CHECK (`backup_destination_kind_shape`,
 * migration 0082), not just a convention: dropping the six S3 NOT NULLs would
 * otherwise leave nothing stopping a half-filled row, and a server row that
 * silently carried no encryption key would be a plaintext backup.
 *
 * `age_recipient` is the PUBLIC key and is the only half the agent gets when
 * writing — a storage host can produce artifacts it cannot read.
 * `age_identity_enc` is the private half, and leaves the control plane only for
 * a restore or a download. `recovery_key_saved_at` drives the "save your
 * recovery key" nudge: a key that exists only inside the thing that might be
 * lost is not a recovery key.
 *
 * `server_id` is RESTRICT, matching `backups.destination_id`: removing a server
 * that still holds a team's backups is a decision, not a cascade.
 * `(team_id, created_at DESC)` index.
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
    // operator's own private network. Instance-admin only to set, the same bar a
    // custom store `path` carries, and for the same reason: the agent dials this
    // address as root. Default false, so nothing anyone creates from the ordinary
    // form can aim inside the deployment.
    allowPrivateEndpoint: boolean("allow_private_endpoint")
      .notNull()
      .default(false),
    // Advanced per-store quirk flags (`--s3-sign-accept-encoding=false`, …), as
    // typed. NULL for every destination that needs none, which is nearly all of
    // them. One column rather than a boolean per quirk: the allowlist that gives
    // them meaning lives in lib/backups/s3-args.ts and in the agent, so the next
    // gateway workaround is not a migration.
    s3ExtraArgs: text("s3_extra_args"),
    status: text("status").notNull(),
    createdAt: isoTimestamptz("created_at").notNull(),
    // Last "Test connection" verdict, kept so the card can say WHY a destination
    // is in `error` and the connection-log dialog can open on the previous run
    // without silently re-dialing the bucket. All four are NULL until the first
    // test. `lastTestError` NULL/"" with a non-null `lastTestAt` ⇒ it passed.
    lastTestAt: isoTimestamptz("last_test_at"),
    lastTestError: text("last_test_error"),
    // The server whose agent served the probe (for `s3`, any backup-capable one
    // can; for `server`, it is always that destination's own host).
    // SET NULL: removing a server must not delete a destination's history.
    lastTestServerId: text("last_test_server_id").references(() => servers.id, {
      onDelete: "set null",
    }),
    lastTestMs: integer("last_test_ms"),
    // Store destinations only: the filesystem headroom the last check saw, so
    // the card can show it without a second RPC. Deliberately NOT a pre-flight
    // gate — a dump's size is unknown until it exists, so this is information
    // for the operator and ENOSPC on the write is the real guard.
    lastFreeBytes: bigint("last_free_bytes", { mode: "number" }),
    lastTotalBytes: bigint("last_total_bytes", { mode: "number" }),
    // The root the agent actually resolved (the managed one when `path` is
    // NULL), so the UI shows a real path rather than a blank.
    resolvedPath: text("resolved_path"),
  },
  (t) => [
    index("backup_destination_team_created_idx").on(t.teamId, t.createdAt.desc()),
    index("backup_destination_last_test_server_idx").on(t.lastTestServerId),
    index("backup_destination_server_idx").on(t.serverId),
    check(
      "backup_destination_kind_shape",
      // The age columns are no longer the `server` kind's alone: a bucket
      // artifact is encrypted too (migration 0086), because a project archive
      // carries the app's whole decrypted env and the bucket was the one place it
      // landed in the clear. They stay NULLABLE for `s3` and only there, so a
      // destination created before that keeps resolving and keeps writing the
      // plaintext artifacts its existing objects already are — the extension on
      // the run's own key is what says which of the two any artifact is.
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
      .references(() => backupDestination.id, { onDelete: "restrict" }),
    schedule: text("schedule").notNull(),
    // The IANA zone `schedule` is read in. "UTC" for every row that existed
    // before migration 0086, which is what they always meant. A backup at 03:00
    // is a backup you want in your own small hours: leaving it UTC-only meant a
    // European team's "nightly" dump ran at 04:00 or 05:00 depending on the
    // season, and the cron-jobs feature next door already carries a per-job zone.
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
      .references(() => backupDestination.id, { onDelete: "restrict" }),
    // The target's id as PLAIN TEXT, alongside the two FK columns above.
    // Deliberate denormalization, and the reason is the `SET NULL` on those FKs:
    // deleting an app or a database blanked the only column that named what its
    // artifacts belonged to, so retention stopped seeing them, no screen listed
    // them, and the files sat on the destination's disk forever with nothing left
    // that could name them. This column survives the delete, so the orphan sweep
    // can still find them (migration 0086).
    targetId: text("target_id").notNull(),
    objectKey: text("object_key").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    // How big the artifact is once DECRYPTED — the exact byte count a download
    // hands the browser, and so its Content-Length. NOT derivable from
    // `size_bytes`: age adds a header plus a tag per 64 KiB chunk, so the stored
    // artifact is always slightly larger than the .tar.gz / .dump.gz inside it,
    // and only the agent that wrote it ever saw both numbers.
    //
    // NULL for every run taken before migration 0092 and for one written by an
    // agent that predates the field. A download then sends no Content-Length,
    // which is exactly what it did before — the browser shows a size-less
    // download rather than a wrong one (migration 0092).
    decryptedSizeBytes: bigint("decrypted_size_bytes", { mode: "number" }),
    // Hex sha256 of the artifact AS WRITTEN (ciphertext, before any decryption).
    // The agent computes it on both halves of a relay and on an S3 upload; the
    // control plane compares them, records the winner here, and re-checks it
    // before a restore. NULL for a run taken before migration 0086, and for those
    // a restore says so rather than silently skipping the check.
    sha256: text("sha256"),
    // When the sweep FIRST saw this run's target gone, not when the backup ran.
    // The keep window for a deleted target's artifacts is measured from here, so
    // deleting an app today does not immediately expire month-old backups the
    // operator explicitly chose to keep (migration 0087).
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
    // FK columns are ON DELETE SET NULL — index them so a delete's cascade is a
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
 *
 * Shaped like `backups` above (team-scoped, XOR target, `schedule` + `enabled`),
 * with three deliberate differences:
 *
 *  - **`timezone` is per job.** `backups.schedule` and the docker-cleanup policy
 *    are UTC-only and get away with it because "some time overnight" is the whole
 *    requirement. A cron job is somebody's business rule - the nightly invoice
 *    run happens at 02:00 *in the company's timezone*, and after a DST shift it
 *    still does. Evaluated by lib/crons/cron-tz.ts, never by getUTC*.
 *  - **`service`, not a container name.** A compose stack's container names are
 *    generated (`deplo-<slug>-<service>-N`) and a redeploy can mint new ones, so
 *    the stable thing to store is the compose service; the container is resolved
 *    live before every attempt. NULL ⇒ the target's primary container, which is
 *    the only possibility for a database.
 *  - **No destination FK.** A backup produces an artifact that outlives its
 *    schedule, which is why `backup_runs.backup_id` is `SET NULL`. A cron run
 *    produces only its own record, so `cron_runs.job_id` CASCADEs: deleting a
 *    job deletes its history, because there is nothing left for the history to
 *    describe.
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
    /** Per ATTEMPT, not per run: it is the agent's `docker exec` deadline, and
     *  the agent knows nothing about the retry ladder. The data layer clamps
     *  `timeout x (maxAttempts) <= 24h` so a retrying run cannot hold the
     *  `running` slot for days and starve every later fire under overlap=skip. */
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
    index("cron_jobs_enabled_idx").on(t.enabled).where(sql`${t.enabled}`),
    index("cron_jobs_team_idx").on(t.teamId),
  ],
);

/**
 * Extra environment for one cron job, on top of whatever the container already
 * has. A child table and not a column because `value_enc` is a real secret: it
 * is AES-GCM ciphertext, it never enters a DTO, and it reaches the host inside
 * the mTLS RPC with the NAME on argv and the VALUE in the docker client's own
 * environment - so it is never readable from `ps` on the box.
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
 *
 * Six statuses: `running | succeeded | failed | timedout | skipped | lost`.
 * `lost` is the one a backup run cannot have and this one must: the command runs
 * inside the AGENT's process, so restarting the control plane does not kill it -
 * we come back and poll for the real exit code. Only an agent restart genuinely
 * loses a run, and calling that `failed` would fire a failure alert for something
 * that most likely succeeded.
 *
 * `UNIQUE(job_id, dedupe_key)` is the whole double-fire story, and it replaces
 * the in-RAM `lastFired` map the backup scheduler keeps: it survives a restart,
 * two control-plane instances racing for the lease, and a backwards clock step.
 * The INSERT is also the serialization point, which is why overlap is decided
 * AFTER it - two instances can never both conclude "nothing else is running".
 *
 * A retry never writes a terminal status: it leaves the row `running` with
 * `agent_job_id` NULL and `next_attempt_at` set. Invariant: a `running` row has
 * exactly one of those two non-null.
 *
 * `command` / `container` / `timeout_seconds` / `max_attempts` are FROZEN at
 * insert. Editing a job mid-flight must not change the deadline the reaper
 * enforces, and history must say what actually ran, not what the job says today.
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
 * [ApiToken](../../types.ts). `token_hash` UNIQUE (hot auth lookup). CASCADE on
 * team and user. A LEAF collection (cut-set (a) — zero-cost-revert) (PLAN §2).
 *
 * A token carries its OWN capabilities (`api_token_capabilities`) and an optional
 * Project scope (`api_token_projects`); it is never root by construction. Its
 * effective power is what it was granted INTERSECTED with what its creator can
 * still do in the team, so revoking a person's access blunts every token they
 * minted (the clamp lives in `lib/membership.ts`).
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
    // teams. Only an instance admin can mint one, and it is mutually exclusive
    // with a narrowed scope: instance-admin gates never consult team
    // capabilities, so a scope could not narrow them.
    instanceAdmin: boolean("instance_admin").notNull().default(false),
    // The INTENT to be scoped, stored separately from the junctions on purpose: a
    // deleted project or app cascades its scope row away, and without this flag an
    // emptied scope would read as "no scope" and silently WIDEN the token to
    // everything. Scoped with zero rows means "reaches nothing".
    scoped: boolean("scoped").notNull().default(false),
    // Set when this token was minted by approving an OAuth consent instead of by
    // the tokens page, and names the client that presented itself. It is what
    // makes an OAuth connection AN ORDINARY API TOKEN rather than a second kind
    // of credential: the access token an AI client sends is only a pointer at
    // this row, so revoking it here stops the next request with no TTL window.
    //
    // The foreign key to `oauth_client(client_id)` lives in migration 0101 only,
    // not here: `schema/auth.ts` already imports `users` from this module, and
    // declaring the reference in Drizzle would close that import cycle.
    oauthClientId: text("oauth_client_id"),
    // When this credential stops working. NULL is "never", which is what every
    // token minted before this column existed keeps. Enforced in
    // `identityForTokenRow` (lib/data/tokens.ts) rather than swept: an expired
    // row stays visible so the tokens page can say WHY it stopped.
    expiresAt: isoTimestamptz("expires_at"),
    lastUsedAt: isoTimestamptz("last_used_at"),
    // When this token last spoke MCP, as opposed to `last_used_at`, which rises
    // on any authenticated request (GraphQL, a deploy hook, a tool call alike).
    // The distinction is the whole point: "this credential is alive" is not
    // "this credential is driving an AI agent", and only the second one can
    // honestly put a row on Settings -> MCP Server. NULL is "never spoke MCP",
    // which is where every token starts and where a CI token stays forever.
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
 * A token's own capabilities — the same forty from `lib/capabilities.ts` a Role is
 * built from. Same shape as `membership_capabilities` / `team_role_capabilities`:
 * one row per granted capability, reassembled into an array on read. `view` is the
 * always-on floor and is stored explicitly, so "no rows" never has two meanings.
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
 * What a token may REACH, as four junctions — one per level of the tree the
 * editor shows: whole Teams, whole Projects, whole Folders, individual Apps. A
 * row means "this node, and everything under it", and a Folder's subtree (its
 * nested folders and their apps) is expanded at authentication time rather than
 * stored, so moving or nesting a folder takes effect immediately.
 *
 * Read together with `api_tokens.scoped`: the flag says whether a scope exists at
 * all, these rows say what is in it. Every FK CASCADEs, so a deleted node simply
 * drops out — which is exactly why the flag has to carry the intent separately.
 *
 * Three tables rather than one with nullable columns: a Postgres PRIMARY KEY
 * cannot contain a nullable column, and the alternatives (a surrogate id plus a
 * COALESCE unique index, or a `kind`/`ref_id` pair with no FK at all) both trade
 * a real foreign key for a discriminant. The token's TEAM set is derived — a
 * project knows its team, an app knows its team — so nothing is denormalized.
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
    // "What has this person done?" — the per-user feed on an account's admin
    // page, which reads across every team and would otherwise seq-scan.
    index("activities_actor_created_idx").on(t.actorUserId, t.createdAt.desc()),
  ],
);

/**
 * ONE configured destination. N per team, and any kind may repeat — two Discord
 * rooms, two on-call phones, and (deliberately: the owner was told it
 * double-notifies the same device) two browser-push instances.
 *
 * Flat columns, not a child table per kind and never JSONB: a channel is a
 * fixed set of named heterogeneous fields, not a list, which is the same reason
 * the settings row this replaces was flat. Twelve child tables would pay a
 * whole table for `{webhook_url}` five times over, and turn the dispatcher's
 * one hot SELECT into twelve joins.
 *
 * Three columns are SHARED because the concept repeats, not to save space:
 *
 *   url          the outbound endpoint — the five chat webhooks, the generic
 *                webhook, the Gotify server, the ntfy server. One column, so
 *                one `assertSafeOutboundUrl` covers every one of them.
 *   target       the addressee inside it — telegram chat id, ntfy topic, the
 *                email To:.
 *   secret_enc   the credential — telegram bot token, gotify app token, ntfy
 *                token, pushover application token, SMTP password.
 *   secret2_enc  the second one — pushover user key, Resend API key. Email uses
 *                BOTH slots, so switching transport never strands a credential.
 *
 * `name` is the team's own label; `''` means unnamed and the UI falls back to
 * the kind's own name. Every credential is `*_enc` and is NEVER projected into
 * a DTO — the instance DTO carries a `…Set: boolean` instead, no reveal path.
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
    /** `smtp` | `resend` — see `EmailProvider`. Resend is the default transport. */
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
 * One row per alert ONE CHANNEL INSTANCE has been decided about — the `alerts`
 * list of a [NotificationChannelInstance](../../types.ts) (PLAN §1: a list is a
 * junction table, never a column per item).
 *
 * `enabled` is a real column rather than "a row means subscribed" because three
 * states are real: on, off, and never said. A team that unticks a default-on
 * alert must stay distinguishable from one that has never opened the page — and
 * an alert key added in a later release has to land on its catalog default
 * (`ALERT_META[key].defaultOn`) for every existing channel, with no backfill.
 * Absent row = the catalog default.
 *
 * The key is the INSTANCE, not the kind: two Discord rooms with different
 * selections is the normal case. That also makes the rule above do double duty —
 * a channel with NO rows at all resolves to exactly the catalog defaults, which
 * is the whole implementation of "a new channel starts on the defaults", with
 * nothing to seed and no write on create.
 *
 * There is deliberately no `team_id`: the cascade comes back through the
 * channel, and that is what makes deleting an instance take its selection with
 * it without a line of application code.
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
 *
 * The browser-issued `endpoint` IS the identity, so it carries the PK — nothing
 * to mint — and both FKs cascade, which is the whole cleanup story when an
 * account or a team goes. A dead endpoint (404/410 from the push service) is
 * pruned at send time; that is the normal end of every subscription.
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
  (t) => [index("registries_team_created_idx").on(t.teamId, t.createdAt.desc())],
);

/**
 * [InstalledPlugin](../../types.ts). `UNIQUE(team_id, catalog_id)` + `UNIQUE(slug)`.
 * `(team_id, created_at DESC)` index. `status`/`url` deliberately NOT stored
 * (computed). Backfill derives the `slug` for legacy empty-slug rows. A LEAF
 * collection (cut-set (a)) (PLAN §2).
 *
 * DORMANT (ADR-0013): the Plugins feature is deferred, so nothing inserts here —
 * the boot sweep (`lib/plugins/retire.ts`) empties it. Kept (not dropped) so the
 * feature can return without a migration.
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

/**
 * [GitConnection](../../types.ts) — a team's credentials for one git host that is
 * NOT GitHub (GitLab, Bitbucket, Gitea/Forgejo, or a plain git server). The
 * counterpart of {@link githubInstallation}: created once in Settings → Git,
 * reused by every App that deploys from that host.
 *
 * GitHub keeps its own pair of tables because a GitHub App is a different animal
 * (a registered application with a private key, minting 1h installation tokens).
 * Every other provider authenticates the same way — a long-lived token used as
 * HTTP basic auth — so they share ONE table with a `provider` discriminator
 * rather than three near-identical ones.
 *
 * `token_enc` / `webhook_secret_enc` are AES-GCM and NEVER projected into a DTO;
 * there is no reveal path (the token is only decrypted at the clone edge and when
 * calling the provider's API). `webhook_token` is the opaque URL segment of
 * `/api/git/webhook/<token>` — it identifies the connection so the route knows
 * which provider sent the delivery and which secret verifies it, without sniffing
 * headers. UNIQUE because it is a routing key.
 *
 * `health` is DERIVED by the twice-daily maintenance sweep (and by "Test
 * connection"): a revoked or expired token is the one failure mode the user
 * cannot see coming, and finding out at the next deploy is finding out too late.
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
    // Opt OUT of the SSRF guard on `base_url`, for a git server that lives on
    // the operator's own private network. Instance-admin only to set - the same
    // bar, and the same reason, as `backup_destinations.allow_private_endpoint`:
    // the control plane dials this address itself and surfaces the response, so
    // an unguarded one is a readable request into its own network. Default
    // false, so nothing created from the ordinary form can aim inside the
    // deployment.
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
 * (disabled), the way a missing `notification_alerts` row does.
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
 * `teams.founder_user_id`, which is `SET NULL`): orphaning the crown must be a loud
 * FK error rather than a silent slide back into the unowned-instance state this row
 * exists to end. There IS a user-deletion path now (`lib/data/user-delete.ts`), and
 * it refuses the owner outright with a message naming the fix — transfer the crown
 * first — so this FK never actually fires; it stays the backstop under that guard.
 * A missing row / NULL owner means "unowned" — legal, and what an
 * instance upgraded from before this migration looks like if it somehow had no
 * admin to backfill from. Recovery for a locked-out owner is the host-side CLI
 * (`bun run recover`), which is why losing the row is survivable rather than fatal.
 */
export const instanceSettings = pgTable("instance_settings", {
  /** Always `'default'`. The row is a singleton; the PK exists to enforce that. */
  id: text("id").primaryKey().default("default"),
  /** The instance owner — see the table comment. NULL means "unowned". */
  ownerUserId: text("owner_user_id").references(() => users.id),
  /**
   * The address this Deplo answers on (`https://deplo.example.com`), as the
   * operator set it in Settings → Deplo. It is what every copy-and-run string
   * Deplo hands out is built from (a server's install command, a deploy hook
   * URL, an invite link), so it has to be editable without shell access to the
   * box that holds `DEPLO_PUBLIC_URL`.
   *
   * NULL means "not configured here" and the resolver falls back to
   * `DEPLO_PUBLIC_URL`, then to the request's own host (`lib/public-url.ts`).
   */
  panelUrl: text("panel_url"),
  /**
   * The VAPID keypair that identifies THIS Deplo to every browser push service
   * (beta). Instance-wide by definition — one identity per panel, not per team —
   * and minted lazily the first time somebody subscribes, so an instance that
   * never uses push never holds one. NULL until then; the private half is
   * encrypted like every other secret.
   */
  vapidPublicKey: text("vapid_public_key"),
  vapidPrivateKeyEnc: text("vapid_private_key_enc"),
  updatedAt: isoTimestamptz("updated_at").notNull(),
});

/* ================================================================== */
/* Rate limiting                                                       */
/* ================================================================== */

/**
 * Fixed-window counters for the sensitive paths (login, the 2FA challenge, the
 * register link, the notification test button).
 *
 * DURABLE, and that is the point - they used to be a process-global `Map`. A
 * restart emptied it, so anyone who could make the control plane restart also
 * handed every account a fresh allowance of login attempts; and a second
 * instance serving the same database would have kept its own, quietly
 * multiplying every limit by the instance count.
 *
 * Deliberately un-scoped: no team, no user FK, no cascade. A bucket is about an
 * ATTEMPT, and the most important attempts are the ones against a subject that
 * may not exist - a guessed address, a token that was already consumed. Joining
 * this to anything would delete exactly the counters an attacker wants gone.
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
/* Dokploy import                                                      */
/* ================================================================== */

/**
 * One run of the Dokploy importer — the report, kept.
 *
 * Shaped like {@link dockerCleanupRuns} because it is the same kind of object: a
 * long operation whose outcome outlives the tab that started it. It exists for
 * one question a company has to be able to answer in the UI: *what came over from
 * the old platform, and what did not*. A report that lives only in the wizard's
 * last step is a report nobody can consult on the day an app turns out to be
 * missing a mount.
 *
 * `source_url` and `org_name` are what the run pointed at. The API key is NEVER
 * stored — it is passed per call and lives in the wizard's component state, so a
 * stale credential cannot be replayed out of deplo's database later.
 *
 * `actor` is free text like `activities.actor`; the row is team-scoped and
 * cascades, because an import belongs to the team it filled.
 */
export const dokployImports = pgTable(
  "dokploy_imports",
  {
    id: text("id").primaryKey(),
    seq: bigint("seq", { mode: "number" }).generatedAlwaysAsIdentity(),
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    /** Origin of the source instance, no key, no path. */
    sourceUrl: text("source_url").notNull(),
    /** The Dokploy organization the key read, when it would say. */
    orgName: text("org_name"),
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
  },
  (t) => [
    index("dokploy_imports_team_started_idx").on(
      t.teamId,
      t.startedAt.desc(),
      t.seq.desc(),
    ),
  ],
);

/**
 * One line of a run's report: a thing that was created, skipped, refused, or
 * imported with something left to do by hand.
 *
 * `outcome` is four values and the fourth is the one that matters:
 *  - `created` — it is in deplo now;
 *  - `skipped` — it was already here (a re-run), or Deplo has no such concept;
 *  - `failed` — a gate or a validation refused it, with the server's own message;
 *  - `manual` — it came across, but something about it needs a human (a private
 *    repo with no credential, a database whose host name changed, a compose file
 *    Deplo had to rewrite).
 *
 * A LIST under a run, so a child table (never a JSONB column). `path` is the
 * readable breadcrumb (`Blink / production / blink-web`) so the report reads the
 * same after the source instance is gone.
 */
export const dokployImportItems = pgTable(
  "dokploy_import_items",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => dokployImports.id, { onDelete: "cascade" }),
    seq: bigint("seq", { mode: "number" }).generatedAlwaysAsIdentity(),
    /** `Project / Environment / service`, as the user saw it on Dokploy. */
    path: text("path").notNull(),
    /** What it was on Dokploy: `application` | `compose` | `postgres` | `domain` | ... */
    sourceKind: text("source_kind").notNull(),
    sourceName: text("source_name").notNull(),
    /**
     * The Dokploy service id this row came from, when the row IS a service.
     *
     * The pairing the data cutover runs on: it asks "what did this Dokploy service
     * become here", and the run is the only place that knows. Matching names across
     * the team instead reached resources the run never created — and the copy
     * WIPES its target, so a stale name match was a way to destroy a database
     * nobody had asked to import. Null on the rows that are not a service (a
     * project, a domain, a note) and on every row written before it existed.
     */
    sourceId: text("source_id"),
    /** `'created'` | `'skipped'` | `'failed'` | `'manual'`. */
    outcome: text("outcome").notNull(),
    /** What it became here: `app` | `database` | `project` | `environment` | ... */
    targetKind: text("target_kind"),
    targetId: text("target_id"),
    message: text("message"),
  },
  (t) => [index("dokploy_import_items_run_idx").on(t.runId, t.seq)],
);
