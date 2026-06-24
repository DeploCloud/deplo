import { count, inArray } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";

import type { Backup, BackupRun, DeploData } from "../../../types";
import {
  backupToRow,
  backupRunToRow,
  databaseToRow,
  s3ToRow,
} from "../../../data/backup-rows";
import {
  backups,
  backupRuns,
  databases,
  s3Destination,
  servers,
} from "../../schema/control-plane";
import type { CutSetCopy } from "../engine";
import type { BackfillTx } from "../types";
import { seedIdentityRoots, seedServers } from "../roots";

/**
 * Cut-set (d) — backups (relational-store PLAN §3 "Cut-set (d)", Step 5). The data
 * aggregate: `databases` + `s3_destination` (their FKs are prerequisites of the
 * schedule/run tables) then `backups` + `backup_runs`, copied from the fresh JSONB
 * at the cut-set's switch moment. It runs LAST (after identity (b) and the project
 * graph (c)) because a backup target FKs a database / project / destination, so
 * those must exist relationally first.
 *
 * Backfill specifics (PLAN §7):
 *  - **FK roots.** Identity (teams/users, cut-set (b)) and `servers` (no cut-set,
 *    bridged) are seeded idempotently — `databases.server_id` RESTRICTs to a
 *    server and every collection here carries a NOT-NULL `team_id`.
 *  - **FK-ordered copy** (PLAN §2): `s3_destination` → `databases` → `backups` →
 *    `backup_runs`. `backups`/`backup_runs` reference `databases`/`s3_destination`
 *    (copied here) and `projects` (cut-set (c), already relational).
 *  - **Orphan prune (the live `deleteProject` bug).** `deleteProject` /
 *    `deleteDatabase` historically left dangling backup/run target ids; the
 *    RESTRICT `destination_id` FK and the schedule `target_kind` XOR forbid
 *    dangling rows, so the copy PRUNES a backup SCHEDULE whose database/project
 *    target or whose destination is gone (PLAN §7 "prunes orphan project-target
 *    backups"). A backup_run's `database_id`/`project_id`/`backup_id` are SET NULL
 *    FKs (history outlives the target), so a dangling one is NULLED rather than
 *    dropping the run; but its `destination_id` is RESTRICT, so a run whose
 *    DESTINATION is gone is pruned (no bucket left to reference).
 *  - **`seq` in source-array order** (PLAN §5). `backup_runs.seq` is a
 *    `bigint identity` the DB assigns; the copy inserts runs in JSONB array order
 *    (which encodes `Array.push` order) so `seq` reproduces insertion order and
 *    retention's `(started_at, seq)` ranking matches the original history.
 *  - **Reconcile is element-granular** (PLAN §7): row counts AFTER prune, the
 *    schedule `target_kind` XOR holds, and every FK resolves.
 *
 * `migrate()` (run by `normalizeForBackfill` before this copy) already stamped a
 * legacy row's `teamId` and defaulted a pre-project-backups schedule's
 * `targetKind`/`projectId`, so the rows reaching here are model-current; this cut-
 * set only prunes dangling FKs + explodes them into columns.
 */

/* ------------------------------------------------------------------ */
/* Copy                                                                */
/* ------------------------------------------------------------------ */

/** Whether a schedule's target (database OR project) is live. */
function backupTargetLive(
  b: Backup,
  liveDatabaseIds: Set<string>,
  liveProjectIds: Set<string>,
): boolean {
  return b.targetKind === "database"
    ? !!b.databaseId && liveDatabaseIds.has(b.databaseId)
    : !!b.projectId && liveProjectIds.has(b.projectId);
}

async function copyBackups(tx: BackfillTx, data: DeploData): Promise<void> {
  // FK roots first (PLAN §2 "roots first"). Identity was migrated by cut-set (b);
  // `servers` is bridged (no cut-set owns it). Seed both idempotently.
  await seedIdentityRoots(tx, data);
  await seedServers(tx, data);

  // The live id sets used for orphan pruning. Databases are copied by THIS cut-set
  // (so the JSONB set is authoritative); projects are relational as of cut-set (c)
  // but the still-live JSONB carries the same project set at switch time.
  const liveDatabaseIds = new Set(data.databases.map((d) => d.id));
  const liveProjectIds = new Set(data.projects.map((p) => p.id));
  const liveDestinationIds = new Set(data.s3Destinations.map((s) => s.id));

  /* --- s3_destination (FK: teams only) --- */
  if (data.s3Destinations.length > 0) {
    await tx.insert(s3Destination).values(data.s3Destinations.map(s3ToRow));
  }

  /* --- databases (FK: servers RESTRICT + teams) --- */
  if (data.databases.length > 0) {
    await tx.insert(databases).values(data.databases.map(databaseToRow));
  }

  /* --- backups schedules (PRUNE dead target / destination) --- */
  const liveBackups = data.backups.filter(
    (b) =>
      liveDestinationIds.has(b.destinationId) &&
      backupTargetLive(b, liveDatabaseIds, liveProjectIds),
  );
  const liveBackupIds = new Set(liveBackups.map((b) => b.id));
  if (liveBackups.length > 0) {
    await tx.insert(backups).values(liveBackups.map(backupToRow));
  }

  /* --- backup_runs history (PRUNE dead destination; NULL dead target/backup) ---
     A run keeps its history even after its target/schedule is gone (the SET NULL
     FKs), so a dangling databaseId/projectId/backupId is NULLED, not dropped. But
     destination_id is RESTRICT, so a run pointing at a vanished bucket is pruned
     (there is no destination row left for the FK to resolve). Insert in source-
     array order so the identity `seq` reproduces insertion order (PLAN §5). */
  const liveRuns = data.backupRuns
    .filter((r) => liveDestinationIds.has(r.destinationId))
    .map((r) => nullDeadRunFks(r, liveDatabaseIds, liveProjectIds, liveBackupIds));
  if (liveRuns.length > 0) {
    await tx.insert(backupRuns).values(liveRuns.map(backupRunToRow));
  }

  await reconcileBackups(tx, data);
}

/** Null a run's SET-NULL FKs that no longer resolve (target / owning schedule). */
function nullDeadRunFks(
  r: BackupRun,
  liveDatabaseIds: Set<string>,
  liveProjectIds: Set<string>,
  liveBackupIds: Set<string>,
): BackupRun {
  return {
    ...r,
    databaseId: r.databaseId && liveDatabaseIds.has(r.databaseId) ? r.databaseId : null,
    projectId: r.projectId && liveProjectIds.has(r.projectId) ? r.projectId : null,
    backupId: r.backupId && liveBackupIds.has(r.backupId) ? r.backupId : null,
  };
}

/* ------------------------------------------------------------------ */
/* Reconcile (element-granular)                                         */
/* ------------------------------------------------------------------ */

async function rowCount(tx: BackfillTx, table: PgTable): Promise<number> {
  const r = await tx.select({ n: count() }).from(table);
  return r[0]?.n ?? 0;
}

function fail(msg: string): never {
  // A reconcile mismatch throws so the engine's tx rolls back, the marker is not
  // written, and the next boot re-runs the copy from the still-live JSONB.
  throw new Error(`[backfill:backups] reconcile mismatch: ${msg}`);
}

/**
 * Element-granular reconciliation of the backups cut-set against the source
 * `data` (PLAN §7). Counts are AFTER the orphan prune, so the expected values are
 * computed over the SAME live sets the copy inserted. Exported so a test can drive
 * a mismatch the DB constraints alone wouldn't catch.
 */
export async function reconcileBackups(
  tx: BackfillTx,
  data: DeploData,
): Promise<void> {
  const liveDatabaseIds = new Set(data.databases.map((d) => d.id));
  const liveProjectIds = new Set(data.projects.map((p) => p.id));
  const liveDestinationIds = new Set(data.s3Destinations.map((s) => s.id));

  /* (1) databases + s3_destination — copied whole (FK roots are seeded, no prune). */
  const dbCount = await rowCount(tx, databases);
  if (dbCount !== data.databases.length)
    fail(`databases ${dbCount} != ${data.databases.length}`);
  const s3Count = await rowCount(tx, s3Destination);
  if (s3Count !== data.s3Destinations.length)
    fail(`s3_destination ${s3Count} != ${data.s3Destinations.length}`);

  /* (2) backups schedules — count AFTER the dead-target / dead-destination prune. */
  const expectedBackups = data.backups.filter(
    (b) =>
      liveDestinationIds.has(b.destinationId) &&
      backupTargetLive(b, liveDatabaseIds, liveProjectIds),
  );
  const backupCount = await rowCount(tx, backups);
  if (backupCount !== expectedBackups.length)
    fail(`backups ${backupCount} != ${expectedBackups.length}`);

  /* (3) backup_runs history — count AFTER the dead-destination prune. */
  const expectedRuns = data.backupRuns.filter((r) =>
    liveDestinationIds.has(r.destinationId),
  );
  const runCount = await rowCount(tx, backupRuns);
  if (runCount !== expectedRuns.length)
    fail(`backup_runs ${runCount} != ${expectedRuns.length}`);

  /* (4) every kept schedule satisfies the target_kind XOR (exactly one target id,
        matching the kind) — the DB CHECK enforces it, but assert here so a
        mis-prune surfaces as a clear reconcile message, not a raw constraint
        violation. */
  for (const b of expectedBackups) {
    const ok =
      b.targetKind === "database"
        ? !!b.databaseId && !b.projectId
        : !!b.projectId && !b.databaseId;
    if (!ok) fail(`backup ${b.id} violates target_kind XOR`);
  }

  /* (5) every backup FK resolves: destination (live), and the target id is in the
        live set for its kind. */
  for (const b of expectedBackups) {
    if (!liveDestinationIds.has(b.destinationId))
      fail(`backup ${b.id} references missing destination ${b.destinationId}`);
    if (b.targetKind === "database" && !liveDatabaseIds.has(b.databaseId!))
      fail(`backup ${b.id} references missing database ${b.databaseId}`);
    if (b.targetKind === "project" && !liveProjectIds.has(b.projectId!))
      fail(`backup ${b.id} references missing project ${b.projectId}`);
  }

  /* (6) every kept run's destination resolves, and its NULLed target/backup FKs
        are consistent with the live sets (a persisted non-null id must be live). */
  if (expectedRuns.length > 0) {
    const persistedRuns = await tx
      .select({
        id: backupRuns.id,
        destinationId: backupRuns.destinationId,
        databaseId: backupRuns.databaseId,
        projectId: backupRuns.projectId,
        backupId: backupRuns.backupId,
      })
      .from(backupRuns);
    const liveDestSet = await tx
      .select({ id: s3Destination.id })
      .from(s3Destination)
      .where(inArray(s3Destination.id, [...liveDestinationIds]));
    const present = new Set(liveDestSet.map((r) => r.id));
    for (const r of persistedRuns) {
      if (!present.has(r.destinationId))
        fail(`backup_run ${r.id} references missing destination ${r.destinationId}`);
      if (r.databaseId && !liveDatabaseIds.has(r.databaseId))
        fail(`backup_run ${r.id} kept a dead databaseId ${r.databaseId}`);
      if (r.projectId && !liveProjectIds.has(r.projectId))
        fail(`backup_run ${r.id} kept a dead projectId ${r.projectId}`);
    }
  }

  /* (7) databases FK to servers resolves. */
  if (data.databases.length > 0) {
    const serverIds = [...new Set(data.databases.map((d) => d.serverId))];
    const presentServers = new Set(
      (
        await tx
          .select({ id: servers.id })
          .from(servers)
          .where(inArray(servers.id, serverIds))
      ).map((r) => r.id),
    );
    for (const d of data.databases) {
      if (!presentServers.has(d.serverId))
        fail(`database ${d.id} references missing server ${d.serverId}`);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Export                                                              */
/* ------------------------------------------------------------------ */

/** The backups cut-set's copy, for {@link runBackfill}. */
export const backupsCutSetCopy: CutSetCopy = copyBackups;
