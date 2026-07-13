import "server-only";

import type {
  BuildConfig,
  BuildMethodSettings,
  Deployment,
  DevConfig,
  Domain,
  EnvTarget,
  EnvVar,
  Folder,
  LogLine,
  App,
  VolumeMount,
} from "../types";
import type {
  deployments,
  deploymentLogs,
  domains,
  domainMiddlewares,
  envVars,
  envVarTargets,
  folders,
  apps,
  appBuild,
  appBuildMethodSettings,
  appDev,
  appMounts,
  appVolumes,
} from "../db/schema/control-plane";

/**
 * The ONE place that maps the app-graph relational rows ↔ the domain objects
 * (`App`, `Domain`, `EnvVar`, `Deployment`, `Folder`)
 * (relational-store PLAN cut-set (c), §1 "No JSONB anywhere — total
 * normalization"). Every reader (the read path) and writer (insert / update) in
 * the data layer goes through here, so reads and writes can never drift on how a
 * project's 5–6 child tables fold into one object — the same anti-drift rationale
 * as `notification-row.ts` for `notification_settings`.
 *
 * `assemble*` turns a parent row + its (already-loaded) child rows into a domain
 * object; `*ToRows` turns a domain object into the flat row + ordered child rows
 * an insert needs. Both halves are PURE — no DB, no store — so the assembler runs
 * in the row-batch-loader and the write path alike. The child rows arrive
 * pre-grouped by the caller (the loader batch-loads with a single `inArray`).
 */

/* ------------------------------------------------------------------ */
/* Drizzle row aliases (inferred from the schema, single source of truth) */
/* ------------------------------------------------------------------ */

export type AppRow = typeof apps.$inferSelect;
export type AppBuildRow = typeof appBuild.$inferSelect;
export type AppBuildMethodSettingsRow =
  typeof appBuildMethodSettings.$inferSelect;
export type AppDevRow = typeof appDev.$inferSelect;
export type AppVolumeRow = typeof appVolumes.$inferSelect;
export type AppMountRow = typeof appMounts.$inferSelect;
export type DeploymentRow = typeof deployments.$inferSelect;
export type DeploymentLogRow = typeof deploymentLogs.$inferSelect;
export type EnvVarRow = typeof envVars.$inferSelect;
export type EnvVarTargetRow = typeof envVarTargets.$inferSelect;
export type DomainRow = typeof domains.$inferSelect;
export type DomainMiddlewareRow = typeof domainMiddlewares.$inferSelect;
export type FolderRow = typeof folders.$inferSelect;

type AppInsert = typeof apps.$inferInsert;
type AppBuildInsert = typeof appBuild.$inferInsert;
type AppBuildMethodSettingsInsert =
  typeof appBuildMethodSettings.$inferInsert;
type AppDevInsert = typeof appDev.$inferInsert;
type AppVolumeInsert = typeof appVolumes.$inferInsert;
type AppMountInsert = typeof appMounts.$inferInsert;
type DomainInsert = typeof domains.$inferInsert;
type DomainMiddlewareInsert = typeof domainMiddlewares.$inferInsert;
type EnvVarInsert = typeof envVars.$inferInsert;
type EnvVarTargetInsert = typeof envVarTargets.$inferInsert;

/* ------------------------------------------------------------------ */
/* The fully-loaded child set for ONE project                          */
/* ------------------------------------------------------------------ */

/**
 * Every child row of a single project, as the row-batch-loader hands them to
 * {@link assembleApp}. `build`/`dev` are 1-to-1 (absent ⇒ null, the
 * tri-state for `dev`); the lists arrive pre-sorted by `position`.
 */
export interface AppChildRows {
  build: AppBuildRow | null;
  methodSettings: AppBuildMethodSettingsRow | null;
  dev: AppDevRow | null;
  volumes: AppVolumeRow[];
  mounts: AppMountRow[];
}

/* ------------------------------------------------------------------ */
/* App: rows → object                                              */
/* ------------------------------------------------------------------ */

/** Reassemble a {@link BuildConfig} from the `app_build` (+ method-settings) rows. */
export function assembleBuild(
  build: AppBuildRow,
  ms: AppBuildMethodSettingsRow | null,
): BuildConfig {
  // Legacy rows may still hold the removed "heroku"/"paketo" build methods.
  // Surface them as "nixpacks" — the same remap normalizeBuildConfig applies on
  // the deploy path — so the settings UI shows a valid, selected method (and a
  // re-save can't persist a method the picker no longer offers).
  const rawMethod = build.buildMethod;
  const buildMethod =
    rawMethod === "heroku" || rawMethod === "paketo" ? "nixpacks" : rawMethod;
  return {
    buildMethod: buildMethod as BuildConfig["buildMethod"],
    methodSettings: assembleMethodSettings(ms),
    rootDirectory: build.rootDirectory,
    includeFilesOutsideRoot: build.includeFilesOutsideRoot,
    skipUnchangedDeployments: build.skipUnchangedDeployments,
    installCommand: build.installCommand,
    buildCommand: build.buildCommand,
    outputDirectory: build.outputDirectory,
    startCommand: build.startCommand,
    runtimeVersion: build.runtimeVersion,
    port: build.port,
  };
}

/**
 * Reassemble {@link BuildMethodSettings} from its 1-to-1 row. Every column is
 * nullable (each settings field is optional); a NULL column ⇒ the key is ABSENT
 * (not `undefined`-valued) so the object round-trips byte-identically and the
 * exhaustive `satisfies` guard below catches a forgotten field.
 */
export function assembleMethodSettings(
  ms: AppBuildMethodSettingsRow | null,
): BuildMethodSettings {
  const out: BuildMethodSettings = {};
  if (!ms) return out;
  if (ms.dockerfilePath != null) out.dockerfilePath = ms.dockerfilePath;
  if (ms.dockerContextPath != null)
    out.dockerContextPath = ms.dockerContextPath;
  if (ms.dockerBuildStage != null) out.dockerBuildStage = ms.dockerBuildStage;
  if (ms.railpackVersion != null) out.railpackVersion = ms.railpackVersion;
  if (ms.nixpacksPublishDirectory != null)
    out.nixpacksPublishDirectory = ms.nixpacksPublishDirectory;
  if (ms.staticSinglePageApp != null)
    out.staticSinglePageApp = ms.staticSinglePageApp;
  return out;
}

/** Reassemble a {@link DevConfig} from the `app_dev` row (null ⇒ absent). */
export function assembleDev(dev: AppDevRow): DevConfig {
  return {
    enabled: dev.enabled,
    status: dev.status,
    imageKind: dev.imageKind as DevConfig["imageKind"],
    image: dev.image,
    devCommand: dev.devCommand,
    port: dev.port,
    previewEnabled: dev.previewEnabled,
    previewHost: dev.previewHost,
    latestStartAt: dev.latestStartAt,
  };
}

/**
 * Fold a project's flat row + its child rows into a {@link App}. A
 * NULL/absent optional column becomes the long-standing null/absent shape. The
 * caller has already applied the read-time normalizers (this is the post-
 * normalize shape), so no further migration runs here.
 */
export function assembleApp(
  row: AppRow,
  children: AppChildRows,
): App {
  if (!children.build)
    // Every project has a 1-to-1 build row (NOT NULL FK), so a missing one is a
    // data-integrity bug, not a tri-state — surface it loudly rather than emit a
    // half-built object the renderer would choke on.
    throw new Error(`project ${row.id} is missing its app_build row`);

  const volumes = [...children.volumes]
    .sort((a, b) => a.position - b.position)
    .map(volumeRowToMount);

  const mounts = [...children.mounts]
    .sort((a, b) => a.position - b.position)
    .map((m) => ({ filePath: m.filePath, content: m.content }));

  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    teamId: row.teamId,
    folderId: row.folderId,
    projectId: row.projectId ?? null,
    environmentId: row.environmentId ?? null,
    serverId: row.serverId,
    migrateFromServerId: row.migrateFromServerId ?? null,
    logo: row.logo,
    source: row.source as App["source"],
    repo: assembleRepo(row),
    dockerImage: row.dockerImage,
    upload: assembleUpload(row),
    compose: row.compose,
    mounts: mounts.length ? mounts : null,
    volumes: volumes.length ? volumes : null,
    build: assembleBuild(children.build, children.methodSettings),
    // Row ABSENT = dev mode never enabled (the tri-state sentinel) ⇒ null.
    dev: children.dev ? assembleDev(children.dev) : null,
    productionUrl: row.productionUrl,
    status: row.status as App["status"],
    autoDeploy: row.autoDeploy,
    latestDeploymentId: row.latestDeploymentId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function assembleRepo(row: AppRow): App["repo"] {
  if (row.repoProvider == null) return null;
  const watchPaths = parseWatchPaths(row.repoWatchPaths);
  // Conditional spread (like installationId): a repo with default deploy options
  // assembles to exactly {provider,url,repo,branch}, so it round-trips unchanged
  // and never looks "dirty". The UIs apply their own display defaults.
  return {
    provider: row.repoProvider as NonNullable<App["repo"]>["provider"],
    url: row.repoUrl ?? "",
    repo: row.repoRepo ?? "",
    branch: row.repoBranch ?? "",
    ...(row.repoInstallationId != null
      ? { installationId: row.repoInstallationId }
      : {}),
    ...(row.repoTriggerType === "tag" ? { triggerType: "tag" as const } : {}),
    ...(watchPaths.length ? { watchPaths } : {}),
    ...(row.repoSubmodules ? { submodules: true } : {}),
  };
}

/** Split the stored newline/comma-separated watch-path globs into a clean list. */
export function parseWatchPaths(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function assembleUpload(row: AppRow): App["upload"] {
  if (row.uploadId == null) return null;
  return {
    id: row.uploadId,
    filename: row.uploadFilename ?? "",
    path: row.uploadPath ?? "",
    size: row.uploadSize ?? 0,
    uploadedAt: row.uploadUploadedAt ?? "",
  };
}

function volumeRowToMount(v: AppVolumeRow): VolumeMount {
  if (v.type === "host") {
    return {
      id: v.volumeId,
      type: "host",
      name: v.name,
      hostPath: v.hostPath ?? "",
      mountPath: v.mountPath,
      readOnly: v.readOnly,
    };
  }
  if (v.type === "app") {
    return {
      id: v.volumeId,
      type: "app",
      name: v.name,
      projectPath: v.projectPath ?? "",
      mountPath: v.mountPath,
      readOnly: v.readOnly,
    };
  }
  // type NULL/absent ⇒ "named" (the back-compat default; do not store "named"
  // explicitly so the object round-trips to the same shape normalizeVolumes emits).
  return { id: v.volumeId, name: v.name, mountPath: v.mountPath, readOnly: v.readOnly };
}

/* ------------------------------------------------------------------ */
/* App: object → rows (for insert)                                 */
/* ------------------------------------------------------------------ */

/**
 * The full row-set for ONE project, FK-ordered for insertion: the flat parent
 * first, then the 1-to-1 children, then the ordered lists. `createApp` builds
 * this and inserts each non-empty array.
 */
export interface AppRowSet {
  project: AppInsert;
  build: AppBuildInsert;
  methodSettings: AppBuildMethodSettingsInsert | null;
  dev: AppDevInsert | null;
  volumes: AppVolumeInsert[];
  mounts: AppMountInsert[];
}

/** The flat `apps` row for a {@link App} (children handled separately). */
export function appToRow(p: App): AppInsert {
  return {
    id: p.id,
    name: p.name,
    slug: p.slug,
    teamId: p.teamId,
    folderId: p.folderId ?? null,
    projectId: p.projectId ?? null,
    environmentId: p.environmentId ?? null,
    serverId: p.serverId,
    migrateFromServerId: p.migrateFromServerId ?? null,
    logo: p.logo ?? null,
    source: p.source,
    repoProvider: p.repo?.provider ?? null,
    repoUrl: p.repo?.url ?? null,
    repoRepo: p.repo?.repo ?? null,
    repoBranch: p.repo?.branch ?? null,
    repoInstallationId: p.repo?.installationId ?? null,
    repoTriggerType: p.repo?.triggerType ?? null,
    repoWatchPaths: p.repo?.watchPaths?.length ? p.repo.watchPaths.join("\n") : null,
    repoSubmodules: p.repo?.submodules ?? false,
    dockerImage: p.dockerImage ?? null,
    uploadId: p.upload?.id ?? null,
    uploadFilename: p.upload?.filename ?? null,
    uploadPath: p.upload?.path ?? null,
    uploadSize: p.upload?.size ?? null,
    uploadUploadedAt: p.upload?.uploadedAt ?? null,
    compose: p.compose ?? null,
    productionUrl: p.productionUrl ?? null,
    status: p.status,
    autoDeploy: p.autoDeploy,
    // `latest_deployment_id` is a forward FK to a deployment that may not exist
    // yet at project-insert time; the caller (createApp) sets it in a second
    // pass after deployments land, or leaves it null.
    latestDeploymentId: null,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

export function buildToRow(appId: string, b: BuildConfig): AppBuildInsert {
  return {
    appId,
    buildMethod: b.buildMethod,
    rootDirectory: b.rootDirectory,
    includeFilesOutsideRoot: b.includeFilesOutsideRoot,
    skipUnchangedDeployments: b.skipUnchangedDeployments,
    installCommand: b.installCommand,
    buildCommand: b.buildCommand,
    outputDirectory: b.outputDirectory,
    startCommand: b.startCommand,
    runtimeVersion: b.runtimeVersion,
    port: b.port,
  };
}

/**
 * The 1-to-1 `app_build_method_settings` row. Each {@link BuildMethodSettings}
 * field maps to one nullable column; the `satisfies` guard makes a newly-added
 * settings field a COMPILE error here (so it can't be silently dropped — the
 * element-granular reconcile counts on exhaustive coverage, PLAN §7).
 */
export function methodSettingsToRow(
  appId: string,
  ms: BuildMethodSettings,
): AppBuildMethodSettingsInsert {
  const cols = {
    dockerfilePath: ms.dockerfilePath ?? null,
    dockerContextPath: ms.dockerContextPath ?? null,
    dockerBuildStage: ms.dockerBuildStage ?? null,
    railpackVersion: ms.railpackVersion ?? null,
    nixpacksPublishDirectory: ms.nixpacksPublishDirectory ?? null,
    staticSinglePageApp: ms.staticSinglePageApp ?? null,
  } satisfies Record<keyof BuildMethodSettings, unknown>;
  return { appId, ...cols };
}

export function devToRow(appId: string, dev: DevConfig): AppDevInsert {
  return {
    appId,
    enabled: dev.enabled,
    status: dev.status,
    imageKind: dev.imageKind,
    image: dev.image,
    devCommand: dev.devCommand,
    port: dev.port,
    previewEnabled: dev.previewEnabled,
    previewHost: dev.previewHost ?? null,
    latestStartAt: dev.latestStartAt ?? null,
  };
}

export function volumesToRows(
  appId: string,
  volumes: App["volumes"],
): AppVolumeInsert[] {
  return (volumes ?? []).map((v, position) => ({
    appId,
    position,
    volumeId: v.id,
    // Store the discriminant only when explicit ("named" stays NULL so it
    // round-trips to the absent-key default).
    type: v.type === "host" || v.type === "app" ? v.type : null,
    name: v.name,
    projectPath: v.type === "app" ? v.projectPath : null,
    hostPath: v.type === "host" ? v.hostPath : null,
    mountPath: v.mountPath,
    readOnly: Boolean(v.readOnly),
  }));
}

export function mountsToRows(
  appId: string,
  mounts: App["mounts"],
): AppMountInsert[] {
  return (mounts ?? []).map((m, position) => ({
    appId,
    position,
    filePath: m.filePath,
    content: m.content,
  }));
}

/** The full FK-ordered row-set for a normalized {@link App}. */
export function appToRowSet(p: App): AppRowSet {
  const ms = methodSettingsToRow(p.id, p.build.methodSettings);
  return {
    project: appToRow(p),
    build: buildToRow(p.id, p.build),
    methodSettings: ms,
    dev: p.dev ? devToRow(p.id, p.dev) : null,
    volumes: volumesToRows(p.id, p.volumes),
    mounts: mountsToRows(p.id, p.mounts),
  };
}

/* ------------------------------------------------------------------ */
/* Domain                                                              */
/* ------------------------------------------------------------------ */

/** Reassemble a {@link Domain} from its row + ordered middleware rows. */
export function assembleDomain(
  row: DomainRow,
  middlewares: DomainMiddlewareRow[],
): Domain {
  const mw = [...middlewares].sort((a, b) => a.position - b.position).map((m) => m.name);
  return {
    id: row.id,
    appId: row.appId,
    name: row.name,
    status: row.status as Domain["status"],
    primary: row.isPrimary,
    redirectTo: row.redirectTo,
    ssl: row.ssl,
    ...(row.source != null ? { source: row.source as Domain["source"] } : {}),
    ...(row.port != null ? { port: row.port } : {}),
    ...(row.entrypoint != null
      ? { entrypoint: row.entrypoint as Domain["entrypoint"] }
      : {}),
    ...(row.certProvider != null
      ? { certProvider: row.certProvider as Domain["certProvider"] }
      : {}),
    ...(mw.length ? { middlewares: mw } : {}),
    ...(row.pathPrefix != null ? { pathPrefix: row.pathPrefix } : {}),
    ...(row.stripPrefix != null ? { stripPrefix: row.stripPrefix } : {}),
    ...(row.service != null ? { service: row.service } : {}),
    createdAt: row.createdAt,
  };
}

/** The flat `domains` row for a {@link Domain} (middlewares handled separately). */
export function domainToRow(d: Domain): DomainInsert {
  return {
    id: d.id,
    appId: d.appId,
    name: d.name,
    status: d.status,
    isPrimary: d.primary,
    redirectTo: d.redirectTo ?? null,
    ssl: d.ssl,
    // entrypoint/certProvider/source NULLABLE with NO default — the auto/manual
    // tri-state; never coerce an absent value to a concrete one.
    source: d.source ?? null,
    port: d.port ?? null,
    entrypoint: d.entrypoint ?? null,
    certProvider: d.certProvider ?? null,
    pathPrefix: d.pathPrefix ?? null,
    stripPrefix: d.stripPrefix ?? null,
    service: d.service ?? null,
    createdAt: d.createdAt,
  };
}

export function domainMiddlewaresToRows(d: Domain): DomainMiddlewareInsert[] {
  return (d.middlewares ?? []).map((name, position) => ({
    domainId: d.id,
    position,
    name,
  }));
}

/* ------------------------------------------------------------------ */
/* EnvVar                                                              */
/* ------------------------------------------------------------------ */

/** Reassemble an {@link EnvVar} from its row + target rows. */
export function assembleEnvVar(
  row: EnvVarRow,
  targets: EnvVarTargetRow[],
): EnvVar {
  return {
    id: row.id,
    appId: row.appId,
    key: row.key,
    valueEnc: row.valueEnc,
    targets: targets.map((t) => t.target as EnvTarget),
    type: row.type as EnvVar["type"],
    createdByUserId: row.createdByUserId,
    updatedByUserId: row.updatedByUserId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function envVarToRow(e: EnvVar): EnvVarInsert {
  return {
    id: e.id,
    appId: e.appId,
    key: e.key,
    valueEnc: e.valueEnc,
    type: e.type,
    createdByUserId: e.createdByUserId,
    updatedByUserId: e.updatedByUserId,
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
  };
}

export function envVarTargetsToRows(e: EnvVar): EnvVarTargetInsert[] {
  return e.targets.map((target) => ({ envVarId: e.id, target }));
}

/* ------------------------------------------------------------------ */
/* Deployment                                                          */
/* ------------------------------------------------------------------ */

/** Reassemble a {@link Deployment} from its row (fully flat). */
export function assembleDeployment(row: DeploymentRow): Deployment {
  return {
    id: row.id,
    appId: row.appId,
    status: row.status as Deployment["status"],
    environment: row.environment as Deployment["environment"],
    commitSha: row.commitSha,
    commitMessage: row.commitMessage,
    commitAuthor: row.commitAuthor,
    branch: row.branch,
    url: row.url,
    createdAt: row.createdAt,
    readyAt: row.readyAt,
    buildDurationMs: row.buildDurationMs,
    creator: row.creator,
    ...(row.buildSource != null
      ? { buildSource: row.buildSource as Deployment["buildSource"] }
      : {}),
  };
}

/** A {@link Deployment} → its insert row. `seq` is DB-generated (omitted). */
export function deploymentToRow(d: Deployment): typeof deployments.$inferInsert {
  return {
    id: d.id,
    appId: d.appId,
    status: d.status,
    environment: d.environment,
    commitSha: d.commitSha,
    commitMessage: d.commitMessage,
    commitAuthor: d.commitAuthor,
    branch: d.branch,
    url: d.url,
    readyAt: d.readyAt ?? null,
    buildDurationMs: d.buildDurationMs ?? null,
    creator: d.creator,
    buildSource: d.buildSource ?? null,
    createdAt: d.createdAt,
  };
}

/* ------------------------------------------------------------------ */
/* Deployment logs                                                     */
/* ------------------------------------------------------------------ */

/** A {@link LogLine} from its row (the `id`/`deployment_id` are reproduction-only). */
export function assembleLogLine(row: DeploymentLogRow): LogLine {
  return { ts: row.ts, level: row.level, text: row.text };
}

/** A {@link LogLine} → its insert row for a deployment. `id` is DB-generated. */
export function logLineToRow(
  deploymentId: string,
  line: LogLine,
): typeof deploymentLogs.$inferInsert {
  return {
    deploymentId,
    ts: line.ts,
    level: line.level,
    text: line.text,
  };
}

// NOTE: shared env GROUP row mappers were removed with the unified shared-var
// model (ADR-0010); the flat `shared_env_vars` parent + junctions are read/written
// directly in lib/data/shared-vars.ts.

/* ------------------------------------------------------------------ */
/* Folder                                                              */
/* ------------------------------------------------------------------ */

/** Reassemble a {@link Folder} from its row. */
export function assembleFolder(row: FolderRow): Folder {
  return {
    id: row.id,
    teamId: row.teamId,
    name: row.name,
    parentId: row.parentId,
    projectId: row.projectId ?? null,
    color: row.color,
    ownerUserId: row.ownerUserId ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function folderToRow(f: Folder): typeof folders.$inferInsert {
  return {
    id: f.id,
    teamId: f.teamId,
    name: f.name,
    parentId: f.parentId ?? null,
    projectId: f.projectId ?? null,
    color: f.color ?? null,
    ownerUserId: f.ownerUserId ?? null,
    createdAt: f.createdAt,
    updatedAt: f.updatedAt,
  };
}
