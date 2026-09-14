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

// deleteBackupRun - delete ONE backup, artifact and record together, the only way
// to retire a single restore point. Artifact FIRST, record second, or the object
// outlives everything that could name it. A `running` run is refused.
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
  // Only a successful run owns a file. A failed one never wrote anything, so its
  // record goes on its own with nothing to delete first.
  if (run.objectKey && run.status === "success") {
    const creds = await getDestinationWithSecretsForTeam(
      teamId,
      run.destinationId,
    );
    // The DESTINATION decides which agent holds the bytes, never the workload's
    // host: an artifact on another server's disk would answer "no such file" and
    // stay behind while the record disappeared.
    const via =
      destinationServerId(creds.destination, target.serverId ?? "") ||
      (await anyBackupCapableServer());
    if (!via)
      throw new Error(
        "No server on this instance can reach the destination this backup is kept in",
      );
    const res = await deleteFromDestination(creds, via, run.objectKey);
    // The agent resolves `ok:false` rather than throwing for a destination-side
    // refusal, so both shapes have to be checked or a failure reads as success.
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

// deleteBackupArtifacts - delete a target's artifacts in ONE destination. BY EXACT
// KEY, never by prefix: two `server` destinations on one host resolve to the SAME
// managed folder, so a prefix sweep deleted the other's artifacts.
export async function deleteBackupArtifacts(input: {
  kind: BackupTargetKind;
  targetId: string;
  destinationId: string;
  serverId: string;
}): Promise<number> {
  const teamId = await requireActiveTeamId();
  // Destructive, and gated on the view floor alone, so the scope check has to
  // be here: a caller-supplied targetId must be one this request can reach.
  if (!(await backupTargetInScope(input.kind, input.targetId)))
    throw new Error("Not found");
  const creds = await getDestinationWithSecretsForTeam(
    teamId,
    input.destinationId,
  );

  // Every run this target has in this destination. A `running` one is in flight
  // and owns no committed artifact yet; a failed one owns none at all.
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

  // `input.serverId` is the TARGET's host and only a fallback: for a server
  // destination the artifacts live on the destination's own disk, which
  // deleteManyFromDestination dials instead.
  const results = await deleteManyFromDestination(
    creds,
    input.serverId,
    withArtifacts.map((r) => ({ key: r.objectKey })),
  );
  // One failure is the whole call's failure: a partial sweep reporting success
  // would delete the target over a folder still holding data.
  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0)
    throw new Error(
      failed[0]!.error ||
        `Could not delete ${failed.length} backup artifact${failed.length === 1 ? "" : "s"}.`,
    );
  const deleted = results.reduce((n, r) => n + r.deleted, 0);

  // EXCEPT a `running` one: its file does not exist yet, so dropping the row
  // means the dump lands an artifact nothing anywhere can name.
  const removable = runs.filter((r) => r.status !== "running").map((r) => r.id);
  if (removable.length > 0)
    await getDb()
      .delete(backupRunsTable)
      .where(inArray(backupRunsTable.id, removable));
  return deleted;
}

// countBackupArtifacts - how many stored artifacts a target still has, one per
// SUCCESSFUL run. Team-scoped; drives the delete dialog's artifact checkbox.
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

// backupDestinationsForTarget - the distinct destinations a target has runs in, so
// a "delete artifacts too" caller can sweep EVERY one. Team-scoped.
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

// deleteAllBackupArtifacts - wipe EVERY artifact of one target across all its
// destinations. Gated on the target's OWN delete capability, and run BEFORE the
// row goes so it still resolves its server.
export async function deleteAllBackupArtifacts(input: {
  kind: BackupTargetKind;
  targetId: string;
}): Promise<{ deleted: number; failedDestinations: string[] }> {
  // Gated on the same capability the target's own deletion requires, in the data
  // layer: one static GraphQL authScope cannot vary by kind.
  const { teamId } =
    input.kind === "app"
      ? await requireAppCapability(input.targetId, "delete_apps")
      : // `delete_databases`, NOT `manage_backups`: whoever may destroy the
        // database may destroy its restore points, nobody else.
        await requireCapability("delete_databases");
  // `manage_backups` survives the project clamp, so the database branch above
  // would otherwise let a narrowed token wipe a target it can't reach.
  if (!(await backupTargetInScope(input.kind, input.targetId)))
    throw new Error("Not found");
  // Straight off the target row, no agent round-trip: a missing/foreign row
  // yields no server and nothing to do.
  const serverId =
    input.kind === "database"
      ? ((await databaseServerId(input.targetId, teamId)) ?? null)
      : ((await loadTeamApp(input.targetId, teamId))?.serverId ?? null);

  const destinations = await backupDestinationsForTarget(input);
  if (destinations.length === 0) return { deleted: 0, failedDestinations: [] };
  if (!serverId) {
    // The target row is gone (or never ours) yet run records linger - there is no
    // owning agent left to reach the buckets.
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
