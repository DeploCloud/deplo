import "server-only";

import { and, count, eq } from "drizzle-orm";

import { getDb } from "../../db/client";
import {
  backups as backupsTable,
  backupRuns as backupRunsTable,
  backupDestination as destTable,
} from "../../db/schema/control-plane/backups";
import { getCurrentUser } from "../../auth/current-user";
import {
  requireActiveTeamId,
  requireCapability,
  requireTeamWide,
} from "../../membership";
import { recordActivity } from "../activity";
import { getDestinationWithSecretsForTeam } from "./credentials";
import { loadDestination } from "./listing";

export async function destinationRemovalImpact(id: string): Promise<{
  schedules: number;
  runs: number;
  artifacts: number;
}> {
  const teamId = await requireActiveTeamId();
  await requireTeamWide("backup destinations");
  const [sched] = await getDb()
    .select({ n: count() })
    .from(backupsTable)
    .where(
      and(eq(backupsTable.destinationId, id), eq(backupsTable.teamId, teamId)),
    );
  const [runs] = await getDb()
    .select({ n: count() })
    .from(backupRunsTable)
    .where(
      and(
        eq(backupRunsTable.destinationId, id),
        eq(backupRunsTable.teamId, teamId),
      ),
    );
  const [stored] = await getDb()
    .select({ n: count() })
    .from(backupRunsTable)
    .where(
      and(
        eq(backupRunsTable.destinationId, id),
        eq(backupRunsTable.teamId, teamId),
        eq(backupRunsTable.status, "success"),
      ),
    );
  return {
    schedules: Number(sched?.n ?? 0),
    runs: Number(runs?.n ?? 0),
    artifacts: Number(stored?.n ?? 0),
  };
}

export async function deleteDestination(
  id: string,
  opts: { deleteArtifacts?: boolean } = {},
): Promise<void> {
  const { membership } = await requireCapability("manage_backup_destinations");
  const teamId = membership.teamId;
  const user = (await getCurrentUser())!;
  const d = await loadDestination(id, teamId);
  if (!d) throw new Error("Not found");

  if (opts.deleteArtifacts) {
    const runs = await getDb()
      .select({ objectKey: backupRunsTable.objectKey })
      .from(backupRunsTable)
      .where(
        and(
          eq(backupRunsTable.destinationId, id),
          eq(backupRunsTable.teamId, teamId),
          eq(backupRunsTable.status, "success"),
        ),
      );
    const keys = runs
      .filter((r) => r.objectKey)
      .map((r) => ({ key: r.objectKey }));
    if (keys.length > 0) {
      const { deleteManyFromDestination } = await import("../backup-transport");
      const creds = await getDestinationWithSecretsForTeam(teamId, id);
      const results = await deleteManyFromDestination(
        creds,
        creds.destination.serverId ?? "",
        keys,
      );
      const failed = results.filter((r) => !r.ok);
      if (failed.length > 0)
        throw new Error(
          failed[0]!.error ||
            `Could not delete ${failed.length} backup file${failed.length === 1 ? "" : "s"}. ` +
              `The destination was not removed.`,
        );
    }
  }
  await getDb().transaction(async (tx) => {
    await tx
      .delete(backupRunsTable)
      .where(
        and(
          eq(backupRunsTable.destinationId, id),
          eq(backupRunsTable.teamId, teamId),
        ),
      );
    await tx
      .delete(backupsTable)
      .where(
        and(
          eq(backupsTable.destinationId, id),
          eq(backupsTable.teamId, teamId),
        ),
      );
    await tx
      .delete(destTable)
      .where(and(eq(destTable.id, id), eq(destTable.teamId, teamId)));
  });
  await recordActivity(
    "s3",
    opts.deleteArtifacts
      ? `Removed backup destination ${d.name} and the backups kept there`
      : `Removed backup destination ${d.name}`,
    user.name,
    null,
    teamId,
  );
}
