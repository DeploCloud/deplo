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
    // ON DELETE SET NULL: deleting a Project orphans its apps to the team top level (ADR-0008).
    projectId: text("project_id").references(() => projects.id, {
      onDelete: "set null",
    }),
    environmentId: text("environment_id").references(() => environments.id, {
      onDelete: "set null",
    }),
    serverId: text("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "restrict" }),
    migrateFromServerId: text("migrate_from_server_id").references(
      () => servers.id,
      { onDelete: "set null" },
    ),
    dataCopyError: text("data_copy_error").notNull().default(""),
    migrationRunId: text("migration_run_id"),
    buildServerId: text("build_server_id").references(() => servers.id, {
      onDelete: "set null",
    }),
    buildFallback: boolean("build_fallback").notNull().default(true),
    logo: text("logo"),
    logoTone: text("logo_tone"),
    framework: text("framework"),
    frameworkOverride: text("framework_override"),
    source: text("source").notNull(),
    repoProvider: text("repo_provider"),
    repoUrl: text("repo_url"),
    repoRepo: text("repo_repo"),
    repoBranch: text("repo_branch"),
    repoInstallationId: text("repo_installation_id"),
    repoConnectionId: text("repo_connection_id"),
    repoTriggerType: text("repo_trigger_type"),
    repoWatchPaths: text("repo_watch_paths"),
    repoSubmodules: boolean("repo_submodules").notNull().default(false),
    dockerImage: text("docker_image"),
    uploadId: text("upload_id"),
    uploadFilename: text("upload_filename"),
    uploadPath: text("upload_path"),
    uploadSize: bigint("upload_size", { mode: "number" }),
    uploadUploadedAt: isoTimestamptz("upload_uploaded_at"),
    compose: text("compose"),
    productionUrl: text("production_url"),
    status: text("status").notNull(),
    autoDeploy: boolean("auto_deploy").notNull(),
    deployHookTokenEnc: text("deploy_hook_token_enc"),
    deployHookEnabled: boolean("deploy_hook_enabled").notNull().default(true),
    composeUpArgs: text("compose_up_args"),
    // A deploy has no user of its own, so this is who a revoked host-privilege grant is read against.
    hostReachBy: text("host_reach_by"),
    rollbackKeep: integer("rollback_keep").notNull().default(3),
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
    healthCheckEnabled: boolean("health_check_enabled")
      .notNull()
      .default(false),
    healthCheckType: text("health_check_type"),
    healthCheckPath: text("health_check_path"),
    healthCheckPort: integer("health_check_port"),
    healthCheckCommand: text("health_check_command"),
    healthCheckIntervalS: integer("health_check_interval_s"),
    healthCheckTimeoutS: integer("health_check_timeout_s"),
    healthCheckRetries: integer("health_check_retries"),
    healthCheckStartPeriodS: integer("health_check_start_period_s"),
    previewEnabled: boolean("preview_enabled").notNull().default(false),
    previewBaseDomain: text("preview_base_domain"),
    previewMaxActive: integer("preview_max_active"),
    previewTtlDays: integer("preview_ttl_days"),
    // NULL means approve: a fork pull request is attacker-authored code, so it waits for a member to unblock it.
    previewForkPolicy: text("preview_fork_policy"),
    previewServerId: text("preview_server_id").references(() => servers.id, {
      onDelete: "set null",
    }),
    previewHttps: boolean("preview_https").notNull().default(false),
    previewAutoDeploy: boolean("preview_auto_deploy").notNull().default(true),
    previewPort: integer("preview_port"),
    previewBuildDrafts: boolean("preview_build_drafts")
      .notNull()
      .default(false),
    previewComment: boolean("preview_comment").notNull().default(true),
    previewRequiredLabels: text("preview_required_labels"),
    cronEnabled: boolean("cron_enabled").notNull().default(false),
    consoleEnabled: boolean("console_enabled").notNull().default(false),
    latestDeploymentId: text("latest_deployment_id").references(
      (): AnyPgColumn => deployments.id,
      { onDelete: "set null" },
    ),
    // ON DELETE SET NULL: removing an account must never destroy an app the team still runs.
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    deletingAt: isoTimestamptz("deleting_at"),
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
    index("apps_created_by_idx").on(t.createdByUserId),
  ],
);

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

export const appBuild = pgTable("app_build", {
  appId: text("app_id")
    .primaryKey()
    .references(() => apps.id, { onDelete: "cascade" }),
  buildMethod: text("build_method").notNull(),
  rootDirectory: text("root_directory").notNull(),
  includeFilesOutsideRoot: boolean("include_files_outside_root")
    .notNull()
    .default(true),
  skipUnchangedDeployments: boolean("skip_unchanged_deployments")
    .notNull()
    .default(false),
  buildCache: boolean("build_cache").notNull().default(true),
  buildCacheClearPending: boolean("build_cache_clear_pending")
    .notNull()
    .default(false),
  installCommand: text("install_command"),
  buildCommand: text("build_command"),
  outputDirectory: text("output_directory"),
  startCommand: text("start_command"),
  runtimeVersion: text("runtime_version").notNull(),
  port: integer("port").notNull(),
});

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
    service: text("service"),
    projectPath: text("project_path"),
    hostPath: text("host_path"),
    mountPath: text("mount_path").notNull(),
    readOnly: boolean("read_only").notNull(),
    propagation: text("propagation"),
  },
  (t) => [primaryKey({ columns: [t.appId, t.position] })],
);

export const appPorts = pgTable(
  "app_ports",
  {
    appId: text("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    portId: text("port_id").notNull(),
    published: integer("published").notNull(),
    target: integer("target").notNull(),
    protocol: text("protocol").notNull().default("tcp"),
  },
  (t) => [primaryKey({ columns: [t.appId, t.position] })],
);

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
