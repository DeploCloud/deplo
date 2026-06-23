import type { BackupRun, BackupTargetKind, DatabaseType } from "../types";

/**
 * Object-key + artifact-extension helpers for backups. Pure (no store, no
 * `server-only`) so they unit-test in isolation and can be shared by the
 * executor, the retention pruner, and any future lister.
 *
 * KEY CONVENTION (PLAN): `deplo/<teamId>/<kind>/<targetId>/<timestamp>.<ext>`.
 * The per-target folder (`deplo/<team>/<kind>/<target>/`) is also the retention
 * PREFIX — `S3Delete(prefix:true)` on it removes every artifact for one target.
 */

/**
 * The artifact extension for a backup target, matching the agent's dump/restore
 * format table (gzip variant): the same stream is gunzipped on restore, so the
 * extension is informational (the agent keys off the descriptor, not the suffix)
 * but kept faithful for human-readable bucket listings.
 */
export function artifactExt(
  kind: BackupTargetKind,
  dbType?: DatabaseType | null,
): string {
  if (kind === "project") return "tar.gz";
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
 * (no colons or millis). ISO-8601 colons are legal in S3 keys but awkward in
 * URLs/tooling, so we compact them. Distinct backups of one target within the
 * same second would collide — the caller passes a unique `runId` suffix to keep
 * keys unique even then.
 */
export function objectStamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

/** The per-target folder prefix — also the retention delete prefix. */
export function targetPrefix(
  teamId: string,
  kind: BackupTargetKind,
  targetId: string,
): string {
  return `deplo/${teamId}/${kind}/${targetId}/`;
}

/**
 * Build the S3 object key for one run. `runId` is appended to the timestamp so
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
 * Choose which of one target's runs to prune — the PURE retention policy,
 * separated from the S3/store I/O so it unit-tests in isolation. `runs` are the
 * runs for ONE target (already filtered); the result is the subset to delete.
 *
 * The rules, in order:
 *  - a `running` run is never pruned (it's in flight);
 *  - the single most-recent SUCCESSFUL run is always kept, so a target is never
 *    left with zero restorable artifacts by a tight window (or a long run of
 *    failures after it);
 *  - every other run is doomed when it's older than `retentionDays` OR beyond the
 *    `maxPerTarget` cap (counting newest-first, across all statuses).
 *
 * Failed runs own no S3 object, so the caller only issues `S3Delete` for the
 * doomed runs that succeeded — but it still drops the failed run records here, so
 * a long tail of failures can't grow the JSONB array unbounded.
 */
export function selectDoomedRuns(
  runs: BackupRun[],
  opts: { retentionDays: number; maxPerTarget: number; now: Date },
): BackupRun[] {
  const ordered = [...runs].sort((a, b) =>
    a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0,
  ); // newest first
  const cutoff = opts.now.getTime() - opts.retentionDays * 24 * 60 * 60 * 1000;
  const newestSuccessId = ordered.find((r) => r.status === "success")?.id ?? null;
  return ordered.filter((r, idx) => {
    if (r.status === "running") return false;
    if (r.id === newestSuccessId) return false;
    const tooOld = new Date(r.startedAt).getTime() < cutoff;
    const overCap = idx >= opts.maxPerTarget;
    return tooOld || overCap;
  });
}
