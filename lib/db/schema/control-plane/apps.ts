import {
  pgTable,
  text,
  integer,
  bigint,
  boolean,
  primaryKey,
  uniqueIndex,
  index,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

import { isoTimestamptz } from "../columns";
import { deployments } from "./deployments";
import { teams, users } from "./identity";
import { environments, folders, projects } from "./projects";
import { servers } from "./servers";

// apps - [App](../../../types.ts), flat scalar columns only.
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
    // Set on a server MOVE when the OLD server still holds the data: it names the host
    // the next successful deploy must copy the data volumes + files dir FROM, via the
    // agent ExportVolume/ImportVolume + ExportFiles/ImportFiles RPCs.
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
    // When the build server cannot compile this app, try the fleet's build fallbacks
    // and then the app's own server, saying so in the deploy log.
    buildFallback: boolean("build_fallback").notNull().default(true),
    logo: text("logo"),
    // The plate the logo needs to stay visible ("dark" / "light"), read from its
    // pixels. Written only for a template's logo: NULL means "the user's own".
    logoTone: text("logo_tone"),
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
    // someone first opens the hook.
    deployHookTokenEnc: text("deploy_hook_token_enc"),
    // The hook's kill switch, ON by default (it is already bearer-gated).
    deployHookEnabled: boolean("deploy_hook_enabled").notNull().default(true),
    // Extra flags this app adds to the `docker compose up` its server runs (migration
    // 0060) - the RAW string as typed; the deploy edge splits it into argv tokens.
    composeUpArgs: text("compose_up_args"),
    // Who last saved a compose that reaches past its container (migration 0141).
    // A deploy has no user of its own, so this is what a revoked grant is read
    // against. NULL means the compose reaches nothing and nothing is checked.
    hostReachBy: text("host_reach_by"),
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
    // `'http'` | `'command'`. NULL only on a row that never turned it on.
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
    // Config saved but not live yet (env vars, resources, ports, health check,
    // build settings). Cleared by the next successful deploy - see commitOutcome.
    pendingChangesAt: isoTimestamptz("pending_changes_at"),
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

// appEnvironments - per-(App, Environment) runtime state: status, URL, latest deployment.
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

// appBuild - [BuildConfig](../../../types.ts) → 1-to-1 child. `build_method` is plain text, legacy values coerced.
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
  // NULL is "Deplo works it out"; an empty string is "run nothing here". They
  // were one value until migration 0147, and the deploy path reads both.
  installCommand: text("install_command"),
  buildCommand: text("build_command"),
  outputDirectory: text("output_directory"),
  startCommand: text("start_command"),
  runtimeVersion: text("runtime_version").notNull(),
  port: integer("port").notNull(),
});

// appBuildMethodSettings - [BuildMethodSettings](../../../types.ts) → 1-to-1 child.
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

// appVolumes - [VolumeMount](../../../types.ts) → ordered child.
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

// appPorts - host ports an app publishes, ordered. Single-image apps only.
export const appPorts = pgTable(
  "app_ports",
  {
    appId: text("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    portId: text("port_id").notNull(),
    // The port on the HOST. Unique per server, which the writer checks.
    published: integer("published").notNull(),
    // The port inside the container.
    target: integer("target").notNull(),
    // "tcp" | "udp".
    protocol: text("protocol").notNull().default("tcp"),
  },
  (t) => [primaryKey({ columns: [t.appId, t.position] })],
);

// appMounts - [App.mounts](../../../types.ts) → ordered child; `content` is byte-preserved.
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
