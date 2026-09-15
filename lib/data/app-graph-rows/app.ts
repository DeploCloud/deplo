import "server-only";

import { isFrameworkId } from "../../apps/framework-catalog";
import { DEFAULT_ROLLBACK_KEEP } from "../../types/app";
import { assembleBuild } from "./build";
import { assembleHealthCheck, healthCheckToRow } from "./health-check";
import { assembleResources, resourceLimitsToRow } from "./resource-limits";
import type { AppBuildRow, AppBuildMethodSettingsRow } from "./build";
import type { App } from "../../types/app";
import type {
  MountPropagation,
  PublishedPort,
  VolumeMount,
} from "../../types/container";
import type {
  apps,
  appMounts,
  appPorts,
  appVolumes,
} from "../../db/schema/control-plane/apps";

export type AppRow = typeof apps.$inferSelect;
export type AppVolumeRow = typeof appVolumes.$inferSelect;
export type AppPortRow = typeof appPorts.$inferSelect;
export type AppMountRow = typeof appMounts.$inferSelect;

type AppInsert = typeof apps.$inferInsert;
type AppVolumeInsert = typeof appVolumes.$inferInsert;
type AppPortInsert = typeof appPorts.$inferInsert;
type AppMountInsert = typeof appMounts.$inferInsert;

export interface AppChildRows {
  build: AppBuildRow | null;
  methodSettings: AppBuildMethodSettingsRow | null;
  volumes: AppVolumeRow[];
  ports: AppPortRow[];
  mounts: AppMountRow[];
}

function byPosition<T extends { position: number }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => a.position - b.position);
}

export function assembleApp(row: AppRow, children: AppChildRows): App {
  if (!children.build)
    throw new Error(`project ${row.id} is missing its app_build row`);

  const volumes = byPosition(children.volumes).map(volumeRowToMount);

  const ports = byPosition(children.ports).map(portRowToPublished);

  const mounts = byPosition(children.mounts).map((m) => ({
    filePath: m.filePath,
    content: m.content,
  }));

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
    dataCopyError: row.dataCopyError ?? "",
    migrationRunId: row.migrationRunId ?? null,
    buildServerId: row.buildServerId ?? null,
    buildFallback: row.buildFallback ?? true,
    logo: row.logo,
    logoTone:
      row.logoTone === "dark" || row.logoTone === "light" ? row.logoTone : null,
    framework: isFrameworkId(row.framework ?? "")
      ? (row.framework as App["framework"])
      : null,
    frameworkOverride: isFrameworkId(row.frameworkOverride ?? "")
      ? (row.frameworkOverride as App["framework"])
      : null,
    source: row.source as App["source"],
    repo: assembleRepo(row),
    dockerImage: row.dockerImage,
    upload: assembleUpload(row),
    compose: row.compose,
    mounts: mounts.length ? mounts : null,
    volumes: volumes.length ? volumes : null,
    ports: ports.length ? ports : null,
    build: assembleBuild(children.build, children.methodSettings),
    productionUrl: row.productionUrl,
    status: row.status as App["status"],
    autoDeploy: row.autoDeploy,
    previewEnabled: row.previewEnabled,
    cronEnabled: row.cronEnabled,
    consoleEnabled: row.consoleEnabled,
    deployHookEnabled: row.deployHookEnabled,
    composeUpArgs: row.composeUpArgs?.trim() ? row.composeUpArgs : null,
    rollbackKeep: row.rollbackKeep,
    resources: assembleResources(row),
    healthCheck: assembleHealthCheck(row),
    latestDeploymentId: row.latestDeploymentId,
    deletingAt: row.deletingAt ?? null,
    pendingChangesAt: row.pendingChangesAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function assembleRepo(row: AppRow): App["repo"] {
  if (row.repoProvider == null) return null;
  const watchPaths = parseWatchPaths(row.repoWatchPaths);
  return {
    provider: row.repoProvider as NonNullable<App["repo"]>["provider"],
    url: row.repoUrl ?? "",
    repo: row.repoRepo ?? "",
    branch: row.repoBranch ?? "",
    ...(row.repoInstallationId != null
      ? { installationId: row.repoInstallationId }
      : {}),
    ...(row.repoConnectionId != null
      ? { connectionId: row.repoConnectionId }
      : {}),
    ...(row.repoTriggerType === "tag" ? { triggerType: "tag" as const } : {}),
    ...(watchPaths.length ? { watchPaths } : {}),
    ...(row.repoSubmodules ? { submodules: true } : {}),
  };
}

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

function portRowToPublished(p: AppPortRow): PublishedPort {
  return {
    id: p.portId,
    published: p.published,
    target: p.target,
    protocol: p.protocol === "udp" ? "udp" : "tcp",
  };
}

function volumeRowToMount(v: AppVolumeRow): VolumeMount {
  const service = v.service ? { service: v.service } : {};
  if (v.type === "host") {
    return {
      id: v.volumeId,
      type: "host",
      name: v.name,
      hostPath: v.hostPath ?? "",
      ...service,
      mountPath: v.mountPath,
      readOnly: v.readOnly,
      ...(v.propagation
        ? { propagation: v.propagation as MountPropagation }
        : {}),
    };
  }
  if (v.type === "app") {
    return {
      id: v.volumeId,
      type: "app",
      name: v.name,
      projectPath: v.projectPath ?? "",
      ...service,
      mountPath: v.mountPath,
      readOnly: v.readOnly,
    };
  }
  return {
    id: v.volumeId,
    name: v.name,
    ...service,
    mountPath: v.mountPath,
    readOnly: v.readOnly,
  };
}

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
    dataCopyError: p.dataCopyError ?? "",
    migrationRunId: p.migrationRunId ?? null,
    buildServerId: p.buildServerId ?? null,
    buildFallback: p.buildFallback ?? true,
    logo: p.logo ?? null,
    logoTone: p.logoTone ?? null,
    framework: p.framework ?? null,
    frameworkOverride: p.frameworkOverride ?? null,
    source: p.source,
    repoProvider: p.repo?.provider ?? null,
    repoUrl: p.repo?.url ?? null,
    repoRepo: p.repo?.repo ?? null,
    repoBranch: p.repo?.branch ?? null,
    repoInstallationId: p.repo?.installationId ?? null,
    repoConnectionId: p.repo?.connectionId ?? null,
    repoTriggerType: p.repo?.triggerType ?? null,
    repoWatchPaths: p.repo?.watchPaths?.length
      ? p.repo.watchPaths.join("\n")
      : null,
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
    deployHookEnabled: p.deployHookEnabled ?? true,
    composeUpArgs: p.composeUpArgs ?? null,
    rollbackKeep: p.rollbackKeep ?? DEFAULT_ROLLBACK_KEEP,
    ...resourceLimitsToRow(p.resources),
    ...healthCheckToRow(p.healthCheck),
    latestDeploymentId: null,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
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
    type: v.type === "host" || v.type === "app" ? v.type : null,
    name: v.name,
    service: v.service?.trim() || null,
    projectPath: v.type === "app" ? v.projectPath : null,
    hostPath: v.type === "host" ? v.hostPath : null,
    mountPath: v.mountPath,
    readOnly: Boolean(v.readOnly),
    propagation: v.type === "host" ? (v.propagation ?? null) : null,
  }));
}

export function portsToRows(
  appId: string,
  ports: App["ports"],
): AppPortInsert[] {
  return (ports ?? []).map((p, position) => ({
    appId,
    position,
    portId: p.id,
    published: p.published,
    target: p.target,
    protocol: p.protocol,
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
