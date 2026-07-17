import type { InferInsertModel, InferSelectModel } from "drizzle-orm";

import { assembleResources, resourceLimitsToRow } from "./app-graph-rows";
import {
  backups,
  backupRuns,
  databases,
  s3Destination,
} from "../db/schema/control-plane";
import type {
  Backup,
  BackupRun,
  BackupRunStatus,
  BackupTargetKind,
  Database,
  DatabaseStatus,
  DatabaseType,
  S3Destination,
  S3Provider,
  S3Status,
} from "../types";

/**
 * The ONE relational-rows ↔ domain-objects mapping for the backups tables
 * (relational-store PLAN §3 cut-set (d) / §2 the data aggregate): `databases`,
 * `s3_destination`, `backups`, `backup_runs`. Every reader and writer in the data
 * layer (`lib/data/{databases,s3,backups}.ts`) goes through here, so reads and
 * writes can't drift on how a row folds into a domain object — the same anti-drift
 * seam `app-graph-rows.ts` is for the project graph and `notification-row.ts`
 * is for `notification_settings`.
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
export type S3DestinationRow = InferSelectModel<typeof s3Destination>;
export type S3DestinationInsert = InferInsertModel<typeof s3Destination>;
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
    sizeMb: d.sizeMb,
    saveMetrics: d.saveMetrics,
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
    sizeMb: row.sizeMb,
    // Opt-in metrics-history switch for the database's Monitoring tab (default false).
    saveMetrics: row.saveMetrics,
    createdAt: row.createdAt,
  };
}

/* ------------------------------------------------------------------ */
/* s3_destination                                                      */
/* ------------------------------------------------------------------ */

/** Explode an {@link S3Destination} into its `s3_destination` row. */
export function s3ToRow(s: S3Destination): S3DestinationInsert {
  return {
    id: s.id,
    teamId: s.teamId,
    name: s.name,
    provider: s.provider,
    endpoint: s.endpoint,
    region: s.region,
    bucket: s.bucket,
    accessKeyEnc: s.accessKeyEnc,
    secretKeyEnc: s.secretKeyEnc,
    status: s.status,
    createdAt: s.createdAt,
  } satisfies Record<keyof S3Destination, unknown> as S3DestinationInsert;
}

/** Reassemble an `s3_destination` row into an {@link S3Destination}. */
export function assembleS3(row: S3DestinationRow): S3Destination {
  return {
    id: row.id,
    teamId: row.teamId,
    name: row.name,
    provider: row.provider as S3Provider,
    endpoint: row.endpoint,
    region: row.region,
    bucket: row.bucket,
    accessKeyEnc: row.accessKeyEnc,
    secretKeyEnc: row.secretKeyEnc,
    status: row.status as S3Status,
    createdAt: row.createdAt,
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
    retentionDays: b.retentionDays,
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
    retentionDays: row.retentionDays,
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
    objectKey: r.objectKey,
    sizeBytes: r.sizeBytes,
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
    objectKey: row.objectKey,
    sizeBytes: row.sizeBytes,
    status: row.status as BackupRunStatus,
    error: row.error,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
  };
}
