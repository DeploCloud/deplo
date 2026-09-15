import "server-only";

import { and, eq, inArray, isNull, lt } from "drizzle-orm";

import { getDb } from "../../db/client";
import {
  backups as backupsTable,
  backupRuns as backupRunsTable,
} from "../../db/schema/control-plane/backups";
import { nowIso } from "../../ids";
import { dispatchAlert } from "../../notify/dispatch";
import { BACKUP_RUN_MAX_MS } from "../../infra/agent-client/deadlines";
import { getDestinationWithSecretsForTeam } from "../destinations/credentials";
import { deleteManyFromDestination } from "../backup-transport";
import { anyBackupCapableServer } from "./target-lookup";

const ORPHAN_ARTIFACT_KEEP_MS = 30 * 24 * 60 * 60_000;

const ORPHAN_SWEEP_BATCH = 500;

export async function sweepOrphanedBackupArtifacts(): Promise<number> {
  const orphanedTargets = and(
    isNull(backupRunsTable.appId),
    isNull(backupRunsTable.databaseId),
  );

  await getDb()
    .update(backupRunsTable)
    .set({ orphanedAt: nowIso() })
    .where(and(orphanedTargets, isNull(backupRunsTable.orphanedAt)));

  const cutoff = new Date(Date.now() - ORPHAN_ARTIFACT_KEEP_MS).toISOString();
  const orphaned = await getDb()
    .select()
    .from(backupRunsTable)
    .where(and(orphanedTargets, lt(backupRunsTable.orphanedAt, cutoff)))
    .orderBy(backupRunsTable.orphanedAt)
    .limit(ORPHAN_SWEEP_BATCH);
  if (orphaned.length === 0) return 0;

  const byDestination = new Map<string, typeof orphaned>();
  for (const r of orphaned) {
    const key = `${r.teamId} ${r.destinationId}`;
    byDestination.set(key, [...(byDestination.get(key) ?? []), r]);
  }

  let reclaimed = 0;
  for (const [key, runs] of byDestination) {
    const [teamId, destinationId] = key.split(" ") as [string, string];
    const removable = new Set(
      runs
        .filter((r) => r.status !== "success" || !r.objectKey)
        .map((r) => r.id),
    );
    const withArtifacts = runs.filter(
      (r) => r.status === "success" && r.objectKey,
    );
    if (withArtifacts.length > 0) {
      try {
        const creds = await getDestinationWithSecretsForTeam(
          teamId,
          destinationId,
        );
        const via =
          creds.destination.serverId ?? (await anyBackupCapableServer());
        if (!via) {
          console.warn(
            `[backups] orphan sweep found no server able to reach destination ` +
              `${destinationId}; will retry`,
          );
          continue;
        }
        const results = await deleteManyFromDestination(
          creds,
          via,
          withArtifacts.map((r) => ({ key: r.objectKey })),
        );
        results.forEach((res, i) => {
          if (!res.ok) return;
          removable.add(withArtifacts[i]!.id);
          reclaimed += res.deleted;
        });
      } catch (e) {
        console.warn(
          `[backups] orphan sweep could not reach destination ${destinationId}: ` +
            `${e instanceof Error ? e.message : String(e)} (will retry)`,
        );
      }
    }
    if (removable.size > 0)
      await getDb()
        .delete(backupRunsTable)
        .where(inArray(backupRunsTable.id, [...removable]));
  }
  if (reclaimed > 0)
    console.log(
      `[deplo] reclaimed ${reclaimed} backup artifact(s) of deleted targets`,
    );
  return reclaimed;
}

const RUN_ORPHAN_AFTER_MS = BACKUP_RUN_MAX_MS;

export async function reconcileInFlightBackupRuns(): Promise<number> {
  const cutoffIso = new Date(Date.now() - RUN_ORPHAN_AFTER_MS).toISOString();
  const finishedAt = nowIso();
  const reconciled = await getDb().transaction(async (tx) => {
    const flipped = await tx
      .update(backupRunsTable)
      .set({
        status: "failed",
        error: "Interrupted by a control-plane restart and marked failed.",
        finishedAt,
      })
      .where(
        and(
          eq(backupRunsTable.status, "running"),
          lt(backupRunsTable.startedAt, cutoffIso),
        ),
      )
      .returning({
        backupId: backupRunsTable.backupId,
        teamId: backupRunsTable.teamId,
      });

    const orphanedBackupIds = [
      ...new Set(
        flipped.map((r) => r.backupId).filter((id): id is string => !!id),
      ),
    ];
    if (orphanedBackupIds.length > 0) {
      await tx
        .update(backupsTable)
        .set({ lastStatus: "failed" })
        .where(
          and(
            eq(backupsTable.lastStatus, "running"),
            inArray(backupsTable.id, orphanedBackupIds),
          ),
        );
    }
    return flipped;
  });
  if (reconciled.length > 0) {
    const perTeam = new Map<string, number>();
    for (const r of reconciled)
      if (r.teamId) perTeam.set(r.teamId, (perTeam.get(r.teamId) ?? 0) + 1);
    for (const [teamId, n] of perTeam)
      dispatchAlert({
        teamId,
        key: "backup_failed",
        title: `${n} backup run${n > 1 ? "s were" : " was"} interrupted`,
        body: "Deplo restarted while they were running. They are marked failed.",
        path: "/storage",
      });
    console.warn(
      `[deplo] reconciled ${reconciled.length} interrupted backup run(s) to failed on startup`,
    );
  }
  return reconciled.length;
}
