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
  Service,
  SharedEnvGroup,
  SharedEnvVar,
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
  services,
  serviceBuild,
  serviceBuildMethodSettings,
  serviceDev,
  serviceMounts,
  serviceVolumes,
  sharedEnvGroups,
  sharedEnvGroupServices,
  sharedEnvGroupTargets,
  sharedEnvGroupVars,
} from "../db/schema/control-plane";

/**
 * The ONE place that maps the service-graph relational rows ↔ the domain objects
 * (`Service`, `Domain`, `EnvVar`, `Deployment`, `SharedEnvGroup`, `Folder`)
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

export type ServiceRow = typeof services.$inferSelect;
export type ServiceBuildRow = typeof serviceBuild.$inferSelect;
export type ServiceBuildMethodSettingsRow =
  typeof serviceBuildMethodSettings.$inferSelect;
export type ServiceDevRow = typeof serviceDev.$inferSelect;
export type ServiceVolumeRow = typeof serviceVolumes.$inferSelect;
export type ServiceMountRow = typeof serviceMounts.$inferSelect;
export type DeploymentRow = typeof deployments.$inferSelect;
export type DeploymentLogRow = typeof deploymentLogs.$inferSelect;
export type EnvVarRow = typeof envVars.$inferSelect;
export type EnvVarTargetRow = typeof envVarTargets.$inferSelect;
export type DomainRow = typeof domains.$inferSelect;
export type DomainMiddlewareRow = typeof domainMiddlewares.$inferSelect;
export type FolderRow = typeof folders.$inferSelect;
export type SharedEnvGroupRow = typeof sharedEnvGroups.$inferSelect;
export type SharedEnvGroupVarRow = typeof sharedEnvGroupVars.$inferSelect;
export type SharedEnvGroupServiceRow =
  typeof sharedEnvGroupServices.$inferSelect;
export type SharedEnvGroupTargetRow = typeof sharedEnvGroupTargets.$inferSelect;

type ServiceInsert = typeof services.$inferInsert;
type ServiceBuildInsert = typeof serviceBuild.$inferInsert;
type ServiceBuildMethodSettingsInsert =
  typeof serviceBuildMethodSettings.$inferInsert;
type ServiceDevInsert = typeof serviceDev.$inferInsert;
type ServiceVolumeInsert = typeof serviceVolumes.$inferInsert;
type ServiceMountInsert = typeof serviceMounts.$inferInsert;
type DomainInsert = typeof domains.$inferInsert;
type DomainMiddlewareInsert = typeof domainMiddlewares.$inferInsert;
type EnvVarInsert = typeof envVars.$inferInsert;
type EnvVarTargetInsert = typeof envVarTargets.$inferInsert;

/* ------------------------------------------------------------------ */
/* The fully-loaded child set for ONE project                          */
/* ------------------------------------------------------------------ */

/**
 * Every child row of a single project, as the row-batch-loader hands them to
 * {@link assembleService}. `build`/`dev` are 1-to-1 (absent ⇒ null, the
 * tri-state for `dev`); the lists arrive pre-sorted by `position`.
 */
export interface ServiceChildRows {
  build: ServiceBuildRow | null;
  methodSettings: ServiceBuildMethodSettingsRow | null;
  dev: ServiceDevRow | null;
  volumes: ServiceVolumeRow[];
  mounts: ServiceMountRow[];
}

/* ------------------------------------------------------------------ */
/* Service: rows → object                                              */
/* ------------------------------------------------------------------ */

/** Reassemble a {@link BuildConfig} from the `service_build` (+ method-settings) rows. */
export function assembleBuild(
  build: ServiceBuildRow,
  ms: ServiceBuildMethodSettingsRow | null,
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
  ms: ServiceBuildMethodSettingsRow | null,
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

/** Reassemble a {@link DevConfig} from the `service_dev` row (null ⇒ absent). */
export function assembleDev(dev: ServiceDevRow): DevConfig {
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
 * Fold a project's flat row + its child rows into a {@link Service}. A
 * NULL/absent optional column becomes the long-standing null/absent shape. The
 * caller has already applied the read-time normalizers (this is the post-
 * normalize shape), so no further migration runs here.
 */
export function assembleService(
  row: ServiceRow,
  children: ServiceChildRows,
): Service {
  if (!children.build)
    // Every project has a 1-to-1 build row (NOT NULL FK), so a missing one is a
    // data-integrity bug, not a tri-state — surface it loudly rather than emit a
    // half-built object the renderer would choke on.
    throw new Error(`project ${row.id} is missing its service_build row`);

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
    source: row.source as Service["source"],
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
    status: row.status as Service["status"],
    autoDeploy: row.autoDeploy,
    latestDeploymentId: row.latestDeploymentId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function assembleRepo(row: ServiceRow): Service["repo"] {
  if (row.repoProvider == null) return null;
  const watchPaths = parseWatchPaths(row.repoWatchPaths);
  // Conditional spread (like installationId): a repo with default deploy options
  // assembles to exactly {provider,url,repo,branch}, so it round-trips unchanged
  // and never looks "dirty". The UIs apply their own display defaults.
  return {
    provider: row.repoProvider as NonNullable<Service["repo"]>["provider"],
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

function assembleUpload(row: ServiceRow): Service["upload"] {
  if (row.uploadId == null) return null;
  return {
    id: row.uploadId,
    filename: row.uploadFilename ?? "",
    path: row.uploadPath ?? "",
    size: row.uploadSize ?? 0,
    uploadedAt: row.uploadUploadedAt ?? "",
  };
}

function volumeRowToMount(v: ServiceVolumeRow): VolumeMount {
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
  if (v.type === "service") {
    return {
      id: v.volumeId,
      type: "service",
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
/* Service: object → rows (for insert)                                 */
/* ------------------------------------------------------------------ */

/**
 * The full row-set for ONE project, FK-ordered for insertion: the flat parent
 * first, then the 1-to-1 children, then the ordered lists. `createService` builds
 * this and inserts each non-empty array.
 */
export interface ServiceRowSet {
  project: ServiceInsert;
  build: ServiceBuildInsert;
  methodSettings: ServiceBuildMethodSettingsInsert | null;
  dev: ServiceDevInsert | null;
  volumes: ServiceVolumeInsert[];
  mounts: ServiceMountInsert[];
}

/** The flat `services` row for a {@link Service} (children handled separately). */
export function serviceToRow(p: Service): ServiceInsert {
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
    // yet at project-insert time; the caller (createService) sets it in a second
    // pass after deployments land, or leaves it null.
    latestDeploymentId: null,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

export function buildToRow(serviceId: string, b: BuildConfig): ServiceBuildInsert {
  return {
    serviceId,
    buildMethod: b.buildMethod,
    rootDirectory: b.rootDirectory,
    installCommand: b.installCommand,
    buildCommand: b.buildCommand,
    outputDirectory: b.outputDirectory,
    startCommand: b.startCommand,
    runtimeVersion: b.runtimeVersion,
    port: b.port,
  };
}

/**
 * The 1-to-1 `service_build_method_settings` row. Each {@link BuildMethodSettings}
 * field maps to one nullable column; the `satisfies` guard makes a newly-added
 * settings field a COMPILE error here (so it can't be silently dropped — the
 * element-granular reconcile counts on exhaustive coverage, PLAN §7).
 */
export function methodSettingsToRow(
  serviceId: string,
  ms: BuildMethodSettings,
): ServiceBuildMethodSettingsInsert {
  const cols = {
    dockerfilePath: ms.dockerfilePath ?? null,
    dockerContextPath: ms.dockerContextPath ?? null,
    dockerBuildStage: ms.dockerBuildStage ?? null,
    railpackVersion: ms.railpackVersion ?? null,
    nixpacksPublishDirectory: ms.nixpacksPublishDirectory ?? null,
    staticSinglePageApp: ms.staticSinglePageApp ?? null,
  } satisfies Record<keyof BuildMethodSettings, unknown>;
  return { serviceId, ...cols };
}

export function devToRow(serviceId: string, dev: DevConfig): ServiceDevInsert {
  return {
    serviceId,
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
  serviceId: string,
  volumes: Service["volumes"],
): ServiceVolumeInsert[] {
  return (volumes ?? []).map((v, position) => ({
    serviceId,
    position,
    volumeId: v.id,
    // Store the discriminant only when explicit ("named" stays NULL so it
    // round-trips to the absent-key default).
    type: v.type === "host" || v.type === "service" ? v.type : null,
    name: v.name,
    projectPath: v.type === "service" ? v.projectPath : null,
    hostPath: v.type === "host" ? v.hostPath : null,
    mountPath: v.mountPath,
    readOnly: Boolean(v.readOnly),
  }));
}

export function mountsToRows(
  serviceId: string,
  mounts: Service["mounts"],
): ServiceMountInsert[] {
  return (mounts ?? []).map((m, position) => ({
    serviceId,
    position,
    filePath: m.filePath,
    content: m.content,
  }));
}

/** The full FK-ordered row-set for a normalized {@link Service}. */
export function serviceToRowSet(p: Service): ServiceRowSet {
  const ms = methodSettingsToRow(p.id, p.build.methodSettings);
  return {
    project: serviceToRow(p),
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
    serviceId: row.serviceId,
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
    serviceId: d.serviceId,
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
    serviceId: row.serviceId,
    key: row.key,
    valueEnc: row.valueEnc,
    targets: targets.map((t) => t.target as EnvTarget),
    type: row.type as EnvVar["type"],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function envVarToRow(e: EnvVar): EnvVarInsert {
  return {
    id: e.id,
    serviceId: e.serviceId,
    key: e.key,
    valueEnc: e.valueEnc,
    type: e.type,
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
    serviceId: row.serviceId,
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
    serviceId: d.serviceId,
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

/* ------------------------------------------------------------------ */
/* Shared env groups                                                   */
/* ------------------------------------------------------------------ */

/** Reassemble a {@link SharedEnvGroup} from its parent + child rows. */
export function assembleSharedEnvGroup(
  row: SharedEnvGroupRow,
  vars: SharedEnvGroupVarRow[],
  serviceIds: SharedEnvGroupServiceRow[],
  targets: SharedEnvGroupTargetRow[],
): SharedEnvGroup {
  return {
    id: row.id,
    teamId: row.teamId,
    name: row.name,
    description: row.description,
    variables: vars.map(
      (v): SharedEnvVar => ({
        key: v.key,
        valueEnc: v.valueEnc,
        type: v.type as SharedEnvVar["type"],
      }),
    ),
    serviceIds: serviceIds.map((p) => p.serviceId),
    targets: targets.map((t) => t.target as EnvTarget),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function sharedEnvGroupToRow(
  g: SharedEnvGroup,
): typeof sharedEnvGroups.$inferInsert {
  return {
    id: g.id,
    teamId: g.teamId,
    name: g.name,
    description: g.description,
    createdAt: g.createdAt,
    updatedAt: g.updatedAt,
  };
}

export function sharedEnvVarsToRows(
  g: SharedEnvGroup,
): (typeof sharedEnvGroupVars.$inferInsert)[] {
  return g.variables.map((v) => ({
    groupId: g.id,
    key: v.key,
    valueEnc: v.valueEnc,
    type: v.type,
  }));
}

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
