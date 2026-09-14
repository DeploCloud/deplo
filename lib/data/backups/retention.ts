import "server-only";

import { and, eq, inArray } from "drizzle-orm";

import { getDb } from "../../db/client";
import { backupRuns as backupRunsTable } from "../../db/schema/control-plane/backups";
import { assembleBackupRun } from "../backup-rows";
import { getDestinationWithSecretsForTeam } from "../destinations/credentials";
import { deleteManyFromDestination } from "../backup-transport";
import { selectDoomedRuns, type RunForRetention } from "../backup-objectkey";
import { runTargetWhere } from "./target-lookup";
import type { ResolvedTarget } from "./target-descriptor";
import type { BackupTargetKind } from "../../types/backup";

// How many run RECORDS a target keeps per destination, regardless of how many
// artifacts its schedule asks for.
export const MAX_RUNS_PER_TARGET = 50;

// pruneRetention - trim a target's artifacts to the newest `keepLast` successful
// runs, and its leftover run RECORDS to the cap. A record is dropped ONLY when its
// object is gone - deleted, or never owned (a failed run).
export async function pruneRetention(
  teamId: string,
  target: ResolvedTarget,
  destinationId: string,
  keepLast: number,
): Promise<void> {
  // Candidates carry their `seq` (the bigint identity) so `selectDoomedRuns` ranks
  // newest-first by `(startedAt, seq)` - a same-millisecond tie ordered by
  // timestamp alone could keep/delete the WRONG object (PLAN §5).
  const candidates = await loadRunsForTarget(
    teamId,
    destinationId,
    target.kind,
    target.kind === "database" ? target.databaseId : target.appId,
  );
  const doomed = selectDoomedRuns(candidates, {
    keepLast,
    // A schedule keeping more artifacts than the record cap raises the cap for
    // itself, otherwise the cap would delete the very artifacts it was asked to
    // keep, and the record it needs to find them by.
    maxRecords: Math.max(MAX_RUNS_PER_TARGET, keepLast),
  });
  if (doomed.length === 0) return;

  // A failed run owns no object - its record can always be dropped. A successful
  // run's record is dropped only once its object is confirmed gone.
  const removable = new Set(
    doomed
      .filter((r) => r.status !== "success" || !r.objectKey)
      .map((r) => r.id),
  );
  const toDelete = doomed.filter((r) => r.status === "success" && r.objectKey);
  if (toDelete.length) {
    const creds = await getDestinationWithSecretsForTeam(teamId, destinationId);
    try {
      // Routed by DESTINATION, not by target: an artifact on another server's
      // disk is only reachable through THAT server's agent, and the workload's
      // host would answer "no such file" forever while the record disappeared.
      const results = await deleteManyFromDestination(
        creds,
        target.serverId,
        toDelete.map((r) => ({ key: r.objectKey })),
      );
      results.forEach((res, i) => {
        const r = toDelete[i]!;
        // The agent resolves `ok:false` (not a throw) on a destination-side failure, so
        // gate on `ok` - only a confirmed delete (incl. idempotent already-gone) retires
        // the record.
        if (res.ok) removable.add(r.id);
        else
          console.warn(
            `[backups] could not delete artifact ${r.objectKey}: ${res.error || "agent reported failure"} (will retry next prune)`,
          );
      });
    } catch (e) {
      // The whole sweep failed (unreachable agent, too old to serve the verb).
      // Every record stays, and the next prune tries again.
      console.warn(
        `[backups] could not delete artifacts for ${target.label}: ${e instanceof Error ? e.message : String(e)} (will retry next prune)`,
      );
    }
  }

  if (removable.size === 0) return;
  await getDb()
    .delete(backupRunsTable)
    .where(inArray(backupRunsTable.id, [...removable]));
}

// loadRunsForTarget - a target's runs in ONE destination, carrying `seq` for
// retention ranking. Exactly one of `databaseId`/`appId` is set; team-scoped.
export async function loadRunsForTarget(
  teamId: string,
  destinationId: string,
  kind: BackupTargetKind,
  targetId: string | null,
): Promise<RunForRetention[]> {
  const rows = await getDb()
    .select()
    .from(backupRunsTable)
    .where(
      and(
        eq(backupRunsTable.teamId, teamId),
        eq(backupRunsTable.destinationId, destinationId),
        runTargetWhere(kind, targetId ?? ""),
      ),
    );
  return rows.map((r) => ({ ...assembleBackupRun(r), seq: r.seq }));
}
