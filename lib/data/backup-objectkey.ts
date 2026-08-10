import type { BackupRun, BackupTargetKind, DatabaseType } from "../types";

/**
 * A {@link BackupRun} plus its DB-generated `seq` (the `bigint identity` on
 * `backup_runs`, PLAN §5) — the shape retention ranks. `seq` totally orders runs
 * written in the same millisecond (a lexicographic `startedAt` sort ties them and
 * could `S3Delete` the WRONG object on a same-ms tie), so it is the tiebreaker
 * after `startedAt`. The relational `pruneRetention` query selects `seq`; a unit
 * test may omit it (the comparator falls back to insertion order for a missing
 * `seq`, preserving the legacy behaviour it asserts).
 */
export type RunForRetention = BackupRun & { seq?: number };

/**
 * Object-key + artifact-extension helpers for backups. Pure (no store, no
 * `server-only`) so they unit-test in isolation and can be shared by the
 * executor, the retention pruner, and any future lister.
 *
 * KEY CONVENTION: `deplo/<teamId>/<kind>/<targetId>/<timestamp>-<runId>.<ext>`.
 *
 * The per-target folder is NOT a delete prefix, and {@link targetPrefix} is only
 * ever a display/grouping aid. It carries no destination segment, and two server
 * destinations on one host with no custom path resolve to the same folder — so a
 * prefix delete crosses destinations. Every delete enumerates exact keys from
 * `backup_runs` instead.
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
  /**
   * Whether this artifact is age-encrypted — which is now every `server`
   * destination and every `s3` one created since bucket artifacts started being
   * encrypted. Encrypted ones get a trailing `.age`, the suffix that tells a
   * human who found the file that `age -d -i recovery-key.txt` is the next step.
   *
   * A BOOLEAN rather than the destination kind, because the kind stopped being
   * the answer: an older `s3` destination has no keypair and still writes
   * plaintext, and calling its artifacts `.age` would be a lie a restore then
   * has to live with. The caller asks the destination whether it has a
   * recipient, which is the same question the agent answers.
   */
  encrypted?: boolean,
): string {
  return baseArtifactExt(kind, dbType) + (encrypted ? ".age" : "");
}

function baseArtifactExt(kind: BackupTargetKind, dbType?: DatabaseType | null): string {
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
 * (no colons or millis). ISO-8601 colons are legal in S3 keys but awkward in
 * URLs/tooling, so we compact them. Distinct backups of one target within the
 * same second would collide — the caller passes a unique `runId` suffix to keep
 * keys unique even then.
 */
export function objectStamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

/** The per-target folder. NOT a delete prefix — see the module doc. */
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
 * Choose which of one target's runs to prune — the PURE retention policy,
 * separated from the S3/store I/O so it unit-tests in isolation. `runs` are the
 * runs for ONE target (already filtered); the result is the subset to delete.
 *
 * Retention is a QUANTITY, not a window: "keep the last N backups" is the
 * question people actually ask, and it is the only one that answers itself on a
 * schedule of any cadence — 7 days of an hourly schedule is 168 artifacts, which
 * nobody asked for and no bucket bill expects.
 *
 * The rules, in order:
 *  - a `running` run is never pruned (it's in flight);
 *  - only SUCCESSFUL runs count toward `keepLast`, newest-first. A failed run
 *    owns no artifact, so letting one occupy a slot would mean three bad nights
 *    silently evicting three good backups — the opposite of what "keep the last
 *    3" promises;
 *  - the single most-recent successful run therefore always survives (`keepLast`
 *    is clamped to >= 1 by the caller), so a target is never left with zero
 *    restorable artifacts;
 *  - a NON-successful run is a record and nothing else, doomed only once it falls
 *    past `maxRecords` counting newest-first across all statuses — the bound that
 *    stops a long tail of failures growing the table.
 *
 * "Newest first" is `(startedAt, seq)` DESC, NOT `startedAt` alone (PLAN §5): two
 * runs written in the same millisecond tie on the timestamp, and ordering them by
 * timestamp alone is non-deterministic — it could pick the wrong "newest
 * successful run to keep" and then delete the live artifact. The DB-generated
 * `seq` (`bigint identity`) breaks that tie by insertion order. The relational
 * `pruneRetention` selects `seq`; if a caller omits it, the tie falls back to the
 * input order.
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
