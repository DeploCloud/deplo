// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import type { BackupRun, BackupTargetKind, DatabaseType } from "../types";

/**
 * A {@link BackupRun} plus its DB-generated `seq` (the `bigint identity` on
 * `backup_runs`, PLAN §5) - the shape retention ranks.
 */
export type RunForRetention = BackupRun & { seq?: number };

/**
 * Object-key + artifact-extension helpers for backups.
 */

/**
 * The artifact extension for a backup target, matching the agent's dump/restore
 * format table (gzip variant): the same stream is gunzipped on restore, so the
 * extension is informational (the agent keys off the descriptor, not the suffix)
 */
export function artifactExt(
  kind: BackupTargetKind,
  dbType?: DatabaseType | null,
  /**
   * Whether this artifact is age-encrypted, which is now every `server`
   * destination and every `s3` one created since bucket artifacts started being
   * encrypted.
   */
  encrypted?: boolean,
): string {
  return baseArtifactExt(kind, dbType) + (encrypted ? ".age" : "");
}

function baseArtifactExt(
  kind: BackupTargetKind,
  dbType?: DatabaseType | null,
): string {
  if (kind === "app") return "tar.gz";
  switch (dbType) {
    case "postgres":
      return "dump.gz";
    case "mongodb":
      return "archive.gz";
    case "redis":
      return "rdb.gz";
    case "mysql":
    case "mariadb":
    case "clickhouse":
      return "sql.gz";
    default:
      // An unknown engine still gets a stable, restorable suffix; the agent's
      // descriptor (not the extension) drives the actual format.
      return "gz";
  }
}

/**
 * A filesystem/URL-friendly UTC timestamp for an object key: `YYYYMMDDTHHMMSSZ`
 * (no colons or millis).
 */
export function objectStamp(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
}

/** The per-target folder. NOT a delete prefix - see the module doc. */
export function targetPrefix(
  teamId: string,
  kind: BackupTargetKind,
  targetId: string,
): string {
  return `deplo/${teamId}/${kind}/${targetId}/`;
}

/**
 * Build the object key for one run. `runId` is appended to the timestamp so
 * two runs of the same target in the same second never collide on the key (and
 * so the key is traceable back to its BackupRun).
 */
export function buildObjectKey(input: {
  teamId: string;
  kind: BackupTargetKind;
  targetId: string;
  runId: string;
  ext: string;
  at: Date;
}): string {
  const { teamId, kind, targetId, runId, ext, at } = input;
  return `${targetPrefix(teamId, kind, targetId)}${objectStamp(at)}-${runId}.${ext}`;
}

/**
 * Choose which of one target's runs to prune - the PURE retention policy,
 * separated from the S3/store I/O so it unit-tests in isolation. The DB-generated
 * `seq` (`bigint identity`) breaks that tie by insertion order.
 */
export function selectDoomedRuns(
  runs: RunForRetention[],
  opts: { keepLast: number; maxRecords: number },
): RunForRetention[] {
  const ordered = [...runs].sort((a, b) => {
    if (a.startedAt !== b.startedAt) return a.startedAt < b.startedAt ? 1 : -1;
    // Same-millisecond tie: `seq` DESC (newer insertion first). Absent seq keeps
    // the input order (stable for the legacy unit test).
    if (a.seq !== undefined && b.seq !== undefined) return b.seq - a.seq;
    return 0;
  }); // newest first
  let kept = 0;
  return ordered.filter((r, idx) => {
    if (r.status === "running") return false;
    // An artifact: keep the newest `keepLast` of them, and only them.
    if (r.status === "success") return ++kept > opts.keepLast;
    // A record with no artifact behind it: bounded, not retained.
    return idx >= opts.maxRecords;
  });
}
