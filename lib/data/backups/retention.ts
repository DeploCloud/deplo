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

export const MAX_RUNS_PER_TARGET = 50;

export async function pruneRetention(
  teamId: string,
  target: ResolvedTarget,
  destinationId: string,
  keepLast: number,
): Promise<void> {
  const candidates = await loadRunsForTarget(
    teamId,
    destinationId,
    target.kind,
    target.kind === "database" ? target.databaseId : target.appId,
  );
  const doomed = selectDoomedRuns(candidates, {
    keepLast,
    maxRecords: Math.max(MAX_RUNS_PER_TARGET, keepLast),
  });
  if (doomed.length === 0) return;

  const removable = new Set(
    doomed
      .filter((r) => r.status !== "success" || !r.objectKey)
      .map((r) => r.id),
  );
  const toDelete = doomed.filter((r) => r.status === "success" && r.objectKey);
  if (toDelete.length) {
    const creds = await getDestinationWithSecretsForTeam(teamId, destinationId);
    try {
      const results = await deleteManyFromDestination(
        creds,
        target.serverId,
        toDelete.map((r) => ({ key: r.objectKey })),
      );
      results.forEach((res, i) => {
        const r = toDelete[i]!;
        if (res.ok) removable.add(r.id);
        else
          console.warn(
            `[backups] could not delete artifact ${r.objectKey}: ${res.error || "agent reported failure"} (will retry next prune)`,
          );
      });
    } catch (e) {
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
