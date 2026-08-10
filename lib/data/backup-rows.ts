import type { InferInsertModel, InferSelectModel } from "drizzle-orm";

import { assembleResources, resourceLimitsToRow } from "./app-graph-rows";
import {
  backups,
  backupRuns,
  databases,
  backupDestination,
} from "../db/schema/control-plane";
import type {
  Backup,
  BackupDestination,
  BackupRun,
  BackupRunStatus,
  BackupTargetKind,
  Database,
  DatabaseStatus,
  DatabaseType,
  DestinationKind,
  DestinationStatus,
  S3Provider,
} from "../types";

/**
 * The ONE relational-rows ↔ domain-objects mapping for the backups tables
 * (relational-store PLAN §3 cut-set (d) / §2 the data aggregate): `databases`,
 * `backup_destination`, `backups`, `backup_runs`. Every reader and writer in the data
 * layer (`lib/data/{databases,s3,backups}.ts`) goes through here, so reads and
 * writes can't drift on how a row folds into a domain object — the same anti-drift
 * seam `app-graph-rows.ts` is for the project graph and `infra-rows.ts` is for
 * the infrastructure tables.
 *
 * Pure — no `server-only`, no store, no db handle — so a `server-only` module can
 * import it freely. These four collections are FLAT (no nested
 * objects, lists, or junctions), so each mapping is a column↔field rename; the
 * load-bearing detail is the `seq` asymmetry: `BackupRun` (the domain type) has no
 * `seq`, but `backup_runs` carries a DB-generated `bigint identity seq` (PLAN §5).
 * {@link backupRunToRow} therefore NEVER writes `seq` (the DB assigns it in
 * insertion order); {@link assembleBackupRun} drops it (the domain object never
 * carries it — retention reads it via a dedicated projection, not the DTO).
 */

export type DatabaseRow = InferSelectModel<typeof databases>;
export type DatabaseInsert = InferInsertModel<typeof databases>;
export type BackupDestinationRow = InferSelectModel<typeof backupDestination>;
export type BackupDestinationInsert = InferInsertModel<typeof backupDestination>;
export type BackupRow = InferSelectModel<typeof backups>;
export type BackupInsert = InferInsertModel<typeof backups>;
export type BackupRunRow = InferSelectModel<typeof backupRuns>;
export type BackupRunInsert = InferInsertModel<typeof backupRuns>;

/* ------------------------------------------------------------------ */
/* databases                                                           */
/* ------------------------------------------------------------------ */

/** Explode a {@link Database} into its `databases` row (exhaustive via satisfies). */
export function databaseToRow(d: Database): DatabaseInsert {
  return {
    id: d.id,
    teamId: d.teamId,
    name: d.name,
    logo: d.logo,
    type: d.type,
    version: d.version,
    username: d.username,
    dbName: d.dbName,
    status: d.status,
    serverId: d.serverId,
    host: d.host,
    port: d.port,
    connectionStringEnc: d.connectionStringEnc,
    exposedPublicly: d.exposedPublicly,
    exposedPort: d.exposedPort,
    // Flattened ResourceLimits — shared with `appToRow` via the one mapping in
    // app-graph-rows.ts (the `resource_*` block is declared identically on both
    // tables), so the two tables can't drift on the column↔field fold.
    ...resourceLimitsToRow(d.resources),
    customImage: d.customImage,
    customCommand: d.customCommand,
    cronEnabled: d.cronEnabled,
    sizeMb: d.sizeMb,
    createdAt: d.createdAt,
  } satisfies Record<
    Exclude<keyof Database, "resources">,
    unknown
  > as DatabaseInsert;
}

/** Reassemble a `databases` row into a {@link Database}. */
export function assembleDatabase(row: DatabaseRow): Database {
  return {
    id: row.id,
    teamId: row.teamId,
    name: row.name,
    logo: row.logo,
    type: row.type as DatabaseType,
    version: row.version,
    username: row.username,
    dbName: row.dbName,
    status: row.status as DatabaseStatus,
    serverId: row.serverId,
    host: row.host,
    port: row.port,
    connectionStringEnc: row.connectionStringEnc,
    exposedPublicly: row.exposedPublicly,
    exposedPort: row.exposedPort,
    // All-NULL resource columns ⇒ no limits set (null) — same fold as apps.
    resources: assembleResources(row),
    customImage: row.customImage,
    customCommand: row.customCommand,
    cronEnabled: row.cronEnabled,
    sizeMb: row.sizeMb,
    createdAt: row.createdAt,
  };
}

/* ------------------------------------------------------------------ */
/* backup_destination                                                  */
/* ------------------------------------------------------------------ */

/**
 * Explode a {@link BackupDestination} into its `backup_destination` row.
 *
 * The kind-specific halves stay NULL rather than empty-string: the DB CHECK
 * (`backup_destination_kind_shape`) reads them, so an `s3` row carrying a stray
 * `""` server id, or a `server` row with an empty bucket, would be rejected at
 * write time — which is exactly what should happen.
 */
export function destinationToRow(d: BackupDestination): BackupDestinationInsert {
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
    status: d.status,
    createdAt: d.createdAt,
    lastTestAt: d.lastTestAt,
    lastTestError: d.lastTestError,
    lastTestServerId: d.lastTestServerId,
    lastTestMs: d.lastTestMs,
    lastFreeBytes: d.lastFreeBytes,
    lastTotalBytes: d.lastTotalBytes,
    resolvedPath: d.resolvedPath,
  } satisfies Record<keyof BackupDestination, unknown> as BackupDestinationInsert;
}

/** Reassemble a `backup_destination` row into a {@link BackupDestination}. */
export function assembleDestination(row: BackupDestinationRow): BackupDestination {
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

/* ------------------------------------------------------------------ */
/* backups (schedule)                                                  */
/* ------------------------------------------------------------------ */

/** Explode a {@link Backup} schedule into its `backups` row. */
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

/** Reassemble a `backups` row into a {@link Backup} schedule. */
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

/* ------------------------------------------------------------------ */
/* backup_runs (history)                                               */
/* ------------------------------------------------------------------ */

/**
 * Explode a {@link BackupRun} into its `backup_runs` row. NEVER writes `seq` — it
 * is a `bigint identity` the DB assigns in insertion order (PLAN §5), so a copy /
 * insert in source-array order reproduces the run history's order. (`seq` is
 * `generatedAlwaysAsIdentity`, so even passing it would be rejected.)
 */
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
    sha256: r.sha256,
    orphanedAt: r.orphanedAt,
    status: r.status,
    error: r.error,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
  } satisfies Record<keyof BackupRun, unknown> as BackupRunInsert;
}

/**
 * Reassemble a `backup_runs` row into a {@link BackupRun}. Drops `seq` (the domain
 * object never carries it — retention reads it via a dedicated `seq`-bearing
 * projection, {@link import("./backup-objectkey").RunForRetention}).
 */
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
    sha256: row.sha256 ?? null,
    orphanedAt: row.orphanedAt ?? null,
    status: row.status as BackupRunStatus,
    error: row.error,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
  };
}
