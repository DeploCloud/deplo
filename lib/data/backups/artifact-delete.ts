import "server-only";

import { and, count, eq, inArray } from "drizzle-orm";

import { getDb } from "../../db/client";
import { backupRuns as backupRunsTable } from "../../db/schema/control-plane/backups";
import { assembleBackupRun } from "../backup-rows";
import { getCurrentUser } from "../../auth/current-user";
import {
  requireActiveTeamId,
  requireCapability,
  requireMembership,
} from "../../membership";
import { recordActivity } from "../activity";
import { requireAppCapability } from "../node-access";
import { loadTeamApp } from "../app-graph-load";
import {
  destinationServerId,
  getDestinationWithSecretsForTeam,
} from "../destinations/credentials";
import {
  deleteFromDestination,
  deleteManyFromDestination,
} from "../backup-transport";
import {
  anyBackupCapableServer,
  databaseServerId,
  downloadTargetFor,
  runTargetWhere,
} from "./target-lookup";
import { backupTargetInScope, requireBackupCapability } from "./target-access";
import { formatBytes } from "./format-bytes";
import type { BackupTargetKind } from "../../types/backup";

export async function deleteBackupRun(runId: string): Promise<void> {
  const { membership } = await requireMembership();
  const teamId = membership.teamId;
  const user = (await getCurrentUser())!;

  const runRows = await getDb()
    .select()
    .from(backupRunsTable)
    .where(
      and(eq(backupRunsTable.id, runId), eq(backupRunsTable.teamId, teamId)),
    )
    .limit(1);
  if (!runRows[0]) throw new Error("Backup not found");
  const run = assembleBackupRun(runRows[0]);
  await requireBackupCapability(run, "delete_backups");
  if (run.status === "running")
    throw new Error("This backup is still running - wait for it to finish");

  const target = await downloadTargetFor(run, teamId);
  if (run.objectKey && run.status === "success") {
    const creds = await getDestinationWithSecretsForTeam(
      teamId,
      run.destinationId,
    );
    const via =
      destinationServerId(creds.destination, target.serverId ?? "") ||
      (await anyBackupCapableServer());
    if (!via)
      throw new Error(
        "No server on this instance can reach the destination this backup is kept in",
      );
    // Artifact first, record second, or the object outlives everything that could name it.
    const res = await deleteFromDestination(creds, via, run.objectKey);
    // The agent resolves ok:false for a destination-side refusal rather than throwing.
    if (!res.ok)
      throw new Error(res.error || "The backup file could not be deleted.");
  }

  await getDb()
    .delete(backupRunsTable)
    .where(
      and(eq(backupRunsTable.id, runId), eq(backupRunsTable.teamId, teamId)),
    );

  await recordActivity(
    "backup",
    `Deleted a backup of ${target.label} from ${formatBytes(run.sizeBytes)}`,
    user.name,
    run.appId,
    teamId,
    null,
    run.databaseId,
  );
}

export async function deleteBackupArtifacts(input: {
  kind: BackupTargetKind;
  targetId: string;
  destinationId: string;
  serverId: string;
}): Promise<number> {
  const teamId = await requireActiveTeamId();
  if (!(await backupTargetInScope(input.kind, input.targetId)))
    throw new Error("Not found");
  const creds = await getDestinationWithSecretsForTeam(
    teamId,
    input.destinationId,
  );

  const runs = await getDb()
    .select({
      id: backupRunsTable.id,
      objectKey: backupRunsTable.objectKey,
      status: backupRunsTable.status,
    })
    .from(backupRunsTable)
    .where(
      and(
        eq(backupRunsTable.teamId, teamId),
        eq(backupRunsTable.destinationId, input.destinationId),
        runTargetWhere(input.kind, input.targetId),
      ),
    );
  const withArtifacts = runs.filter(
    (r) => r.status === "success" && r.objectKey,
  );

  // By exact key, never by prefix: two server destinations on one host share the same managed folder.
  const results = await deleteManyFromDestination(
    creds,
    input.serverId,
    withArtifacts.map((r) => ({ key: r.objectKey })),
  );
  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0)
    throw new Error(
      failed[0]!.error ||
        `Could not delete ${failed.length} backup artifact${failed.length === 1 ? "" : "s"}.`,
    );
  const deleted = results.reduce((n, r) => n + r.deleted, 0);

  // A running run owns no artifact yet, so dropping its row would orphan the dump it is about to land.
  const removable = runs.filter((r) => r.status !== "running").map((r) => r.id);
  if (removable.length > 0)
    await getDb()
      .delete(backupRunsTable)
      .where(inArray(backupRunsTable.id, removable));
  return deleted;
}

export async function countBackupArtifacts(input: {
  kind: BackupTargetKind;
  targetId: string;
}): Promise<number> {
  const teamId = await requireActiveTeamId();
  if (!(await backupTargetInScope(input.kind, input.targetId))) return 0;
  const [row] = await getDb()
    .select({ n: count() })
    .from(backupRunsTable)
    .where(
      and(
        eq(backupRunsTable.teamId, teamId),
        eq(backupRunsTable.status, "success"),
        runTargetWhere(input.kind, input.targetId),
      ),
    );
  return Number(row?.n ?? 0);
}

export async function backupDestinationsForTarget(input: {
  kind: BackupTargetKind;
  targetId: string;
}): Promise<string[]> {
  const teamId = await requireActiveTeamId();
  if (!(await backupTargetInScope(input.kind, input.targetId))) return [];
  const rows = await getDb()
    .selectDistinct({ destinationId: backupRunsTable.destinationId })
    .from(backupRunsTable)
    .where(
      and(
        eq(backupRunsTable.teamId, teamId),
        runTargetWhere(input.kind, input.targetId),
      ),
    );
  return rows.map((r) => r.destinationId);
}

export async function deleteAllBackupArtifacts(input: {
  kind: BackupTargetKind;
  targetId: string;
}): Promise<{ deleted: number; failedDestinations: string[] }> {
  const { teamId } =
    input.kind === "app"
      ? await requireAppCapability(input.targetId, "delete_apps")
      : await requireCapability("delete_databases");
  // The capability alone cannot see a project clamp, so a narrowed token is refused by this scope check.
  if (!(await backupTargetInScope(input.kind, input.targetId)))
    throw new Error("Not found");
  const serverId =
    input.kind === "database"
      ? ((await databaseServerId(input.targetId, teamId)) ?? null)
      : ((await loadTeamApp(input.targetId, teamId))?.serverId ?? null);

  const destinations = await backupDestinationsForTarget(input);
  if (destinations.length === 0) return { deleted: 0, failedDestinations: [] };
  if (!serverId) {
    await getDb()
      .delete(backupRunsTable)
      .where(
        and(
          eq(backupRunsTable.teamId, teamId),
          runTargetWhere(input.kind, input.targetId),
        ),
      );
    return { deleted: 0, failedDestinations: destinations };
  }

  let deleted = 0;
  const failedDestinations: string[] = [];
  for (const destinationId of destinations) {
    try {
      deleted += await deleteBackupArtifacts({
        kind: input.kind,
        targetId: input.targetId,
        destinationId,
        serverId,
      });
    } catch (e) {
      console.warn(
        `[backups] failed to delete artifacts for ${input.kind} ${input.targetId} ` +
          `in destination ${destinationId}: ${e instanceof Error ? e.message : String(e)}`,
      );
      failedDestinations.push(destinationId);
    }
  }
  return { deleted, failedDestinations };
}
