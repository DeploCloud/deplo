import type { BackupRun, BackupTargetKind } from "../types/backup";
import type { DatabaseType } from "../types/database";

export type RunForRetention = BackupRun & { seq?: number };

export function artifactExt(
  kind: BackupTargetKind,
  dbType?: DatabaseType | null,
  encrypted?: boolean,
  baseBackup = false,
): string {
  return (
    (baseBackup ? BASE_BACKUP_EXT : baseArtifactExt(kind, dbType)) +
    (encrypted ? ".age" : "")
  );
}

const BASE_BACKUP_EXT = "base.tar.gz";

/** A Postgres base backup, which the change log is replayed onto; every other artifact is a dump. */
export function isBaseBackupKey(key: string): boolean {
  return /\.base\.tar\.gz(\.age)?$/.test(key);
}

/** The folder beside a base backup that holds the change log archived after it. */
export function changeLogPrefix(baseKey: string): string {
  return `${baseKey}.wal`;
}

/** One shipment of the change log: its time sorts it, its ending says whether it is encrypted like its base. */
export function changeLogKey(baseKey: string, at: Date): string {
  return `${changeLogPrefix(baseKey)}/${objectStamp(at)}.tar.gz${baseKey.endsWith(".age") ? ".age" : ""}`;
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
      return "gz";
  }
}

export function objectStamp(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
}

export function targetPrefix(
  teamId: string,
  kind: BackupTargetKind,
  targetId: string,
): string {
  return `deplo/${teamId}/${kind}/${targetId}/`;
}

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

export function selectDoomedRuns(
  runs: RunForRetention[],
  opts: { keepLast: number; maxRecords: number },
): RunForRetention[] {
  const ordered = [...runs].sort((a, b) => {
    if (a.startedAt !== b.startedAt) return a.startedAt < b.startedAt ? 1 : -1;
    if (a.seq !== undefined && b.seq !== undefined) return b.seq - a.seq;
    return 0;
  });
  let kept = 0;
  return ordered.filter((r, idx) => {
    if (r.status === "running") return false;
    if (r.status === "success") return ++kept > opts.keepLast;
    return idx >= opts.maxRecords;
  });
}
