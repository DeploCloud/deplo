import type { BackupRun, BackupTargetKind } from "../types/backup";
import type { DatabaseType } from "../types/database";

export type RunForRetention = BackupRun & { seq?: number };

export function artifactExt(
  kind: BackupTargetKind,
  dbType?: DatabaseType | null,
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
