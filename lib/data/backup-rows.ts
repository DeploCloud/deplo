import type { InferInsertModel, InferSelectModel } from "drizzle-orm";

import {
  assembleResources,
  resourceLimitsToRow,
} from "./app-graph-rows/resource-limits";
import {
  backups,
  backupRuns,
  backupDestination,
} from "../db/schema/control-plane/backups";
import { databases } from "../db/schema/control-plane/databases";
import type {
  Backup,
  BackupDestination,
  BackupRun,
  BackupRunStatus,
  BackupTargetKind,
  DestinationKind,
  DestinationStatus,
  S3Provider,
} from "../types/backup";
import type {
  Database,
  DatabaseMount,
  DatabaseStatus,
  DatabaseType,
} from "../types/database";

export type DatabaseRow = InferSelectModel<typeof databases>;
export type DatabaseInsert = InferInsertModel<typeof databases>;
export type BackupDestinationRow = InferSelectModel<typeof backupDestination>;
export type BackupDestinationInsert = InferInsertModel<
  typeof backupDestination
>;
export type BackupRow = InferSelectModel<typeof backups>;
export type BackupInsert = InferInsertModel<typeof backups>;
export type BackupRunRow = InferSelectModel<typeof backupRuns>;
export type BackupRunInsert = InferInsertModel<typeof backupRuns>;

export function databaseToRow(d: Database): DatabaseInsert {
  return {
    id: d.id,
    teamId: d.teamId,
    environmentId: d.environmentId,
    name: d.name,
    logo: d.logo,
    type: d.type,
    version: d.version,
    username: d.username,
    dbName: d.dbName,
    status: d.status,
    dataCopyError: d.dataCopyError,
    migrationRunId: d.migrationRunId,
    serverId: d.serverId,
    host: d.host,
    port: d.port,
    connectionStringEnc: d.connectionStringEnc,
    exposedPublicly: d.exposedPublicly,
    exposedPort: d.exposedPort,
    ...resourceLimitsToRow(d.resources),
    customImage: d.customImage,
    customCommand: d.customCommand,
    cronEnabled: d.cronEnabled,
    restartLoopGuard: d.restartLoopGuard,
    restartLoopStoppedAt: d.restartLoopStoppedAt,
    sizeMb: d.sizeMb,
    createdAt: d.createdAt,
  } satisfies Record<
    Exclude<keyof Database, "resources" | "mounts">,
    unknown
  > as DatabaseInsert;
}

export function assembleDatabase(
  row: DatabaseRow,
  mounts: DatabaseMount[] = [],
): Database {
  return {
    id: row.id,
    teamId: row.teamId,
    environmentId: row.environmentId ?? null,
    name: row.name,
    logo: row.logo,
    type: row.type as DatabaseType,
    version: row.version,
    username: row.username,
    dbName: row.dbName,
    status: row.status as DatabaseStatus,
    dataCopyError: row.dataCopyError ?? "",
    migrationRunId: row.migrationRunId ?? null,
    serverId: row.serverId,
    host: row.host,
    port: row.port,
    connectionStringEnc: row.connectionStringEnc,
    exposedPublicly: row.exposedPublicly,
    exposedPort: row.exposedPort,
    resources: assembleResources(row),
    customImage: row.customImage,
    customCommand: row.customCommand,
    cronEnabled: row.cronEnabled,
    restartLoopGuard: row.restartLoopGuard,
    restartLoopStoppedAt: row.restartLoopStoppedAt ?? null,
    mounts,
    sizeMb: row.sizeMb,
    createdAt: row.createdAt,
  };
}

export function destinationToRow(
  d: BackupDestination,
): BackupDestinationInsert {
  return {
    id: d.id,
    teamId: d.teamId,
    name: d.name,
    kind: d.kind,
    provider: d.provider,
    endpoint: d.endpoint,
    region: d.region,
    bucket: d.bucket,
    accessKeyEnc: d.accessKeyEnc,
    secretKeyEnc: d.secretKeyEnc,
    serverId: d.serverId,
    path: d.path,
    ageRecipient: d.ageRecipient,
    ageIdentityEnc: d.ageIdentityEnc,
    recoveryKeySavedAt: d.recoveryKeySavedAt,
    allowPrivateEndpoint: d.allowPrivateEndpoint,
    s3ExtraArgs: d.s3ExtraArgs,
    status: d.status,
    createdAt: d.createdAt,
    lastTestAt: d.lastTestAt,
    lastTestError: d.lastTestError,
    lastTestServerId: d.lastTestServerId,
    lastTestMs: d.lastTestMs,
    lastFreeBytes: d.lastFreeBytes,
    lastTotalBytes: d.lastTotalBytes,
    resolvedPath: d.resolvedPath,
  } satisfies Record<
    keyof BackupDestination,
    unknown
  > as BackupDestinationInsert;
}

export function assembleDestination(
  row: BackupDestinationRow,
): BackupDestination {
  return {
    id: row.id,
    teamId: row.teamId,
    name: row.name,
    kind: row.kind as DestinationKind,
    provider: (row.provider as S3Provider | null) ?? null,
    endpoint: row.endpoint ?? null,
    region: row.region ?? null,
    bucket: row.bucket ?? null,
    accessKeyEnc: row.accessKeyEnc ?? null,
    secretKeyEnc: row.secretKeyEnc ?? null,
    serverId: row.serverId ?? null,
    path: row.path ?? null,
    ageRecipient: row.ageRecipient ?? null,
    ageIdentityEnc: row.ageIdentityEnc ?? null,
    recoveryKeySavedAt: row.recoveryKeySavedAt ?? null,
    allowPrivateEndpoint: row.allowPrivateEndpoint,
    s3ExtraArgs: row.s3ExtraArgs,
    status: row.status as DestinationStatus,
    createdAt: row.createdAt,
    lastTestAt: row.lastTestAt ?? null,
    lastTestError: row.lastTestError ?? null,
    lastTestServerId: row.lastTestServerId ?? null,
    lastTestMs: row.lastTestMs ?? null,
    lastFreeBytes: row.lastFreeBytes ?? null,
    lastTotalBytes: row.lastTotalBytes ?? null,
    resolvedPath: row.resolvedPath ?? null,
  };
}

export function backupToRow(b: Backup): BackupInsert {
  return {
    id: b.id,
    teamId: b.teamId,
    name: b.name,
    targetKind: b.targetKind,
    databaseId: b.databaseId,
    appId: b.appId,
    destinationId: b.destinationId,
    schedule: b.schedule,
    timezone: b.timezone,
    retentionCount: b.retentionCount,
    lastRunAt: b.lastRunAt,
    lastStatus: b.lastStatus,
    enabled: b.enabled,
    createdAt: b.createdAt,
  } satisfies Record<keyof Backup, unknown> as BackupInsert;
}

export function assembleBackup(row: BackupRow): Backup {
  return {
    id: row.id,
    teamId: row.teamId,
    name: row.name,
    targetKind: row.targetKind as BackupTargetKind,
    databaseId: row.databaseId,
    appId: row.appId,
    destinationId: row.destinationId,
    schedule: row.schedule,
    timezone: row.timezone,
    retentionCount: row.retentionCount,
    lastRunAt: row.lastRunAt,
    lastStatus: row.lastStatus as Backup["lastStatus"],
    enabled: row.enabled,
    createdAt: row.createdAt,
  };
}

export function backupRunToRow(r: BackupRun): BackupRunInsert {
  return {
    id: r.id,
    teamId: r.teamId,
    backupId: r.backupId,
    targetKind: r.targetKind,
    databaseId: r.databaseId,
    appId: r.appId,
    destinationId: r.destinationId,
    targetId: r.targetId,
    objectKey: r.objectKey,
    sizeBytes: r.sizeBytes,
    decryptedSizeBytes: r.decryptedSizeBytes,
    sha256: r.sha256,
    orphanedAt: r.orphanedAt,
    status: r.status,
    error: r.error,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
  } satisfies Record<keyof BackupRun, unknown> as BackupRunInsert;
}

export function assembleBackupRun(row: BackupRunRow): BackupRun {
  return {
    id: row.id,
    teamId: row.teamId,
    backupId: row.backupId,
    targetKind: row.targetKind as BackupTargetKind,
    databaseId: row.databaseId,
    appId: row.appId,
    destinationId: row.destinationId,
    targetId: row.targetId,
    objectKey: row.objectKey,
    sizeBytes: row.sizeBytes,
    decryptedSizeBytes: row.decryptedSizeBytes ?? null,
    sha256: row.sha256 ?? null,
    orphanedAt: row.orphanedAt ?? null,
    status: row.status as BackupRunStatus,
    error: row.error,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
  };
}
