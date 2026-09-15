import "server-only";

import { getCurrentUser } from "../../auth/current-user";
import {
  reachesWholeTeam,
  requireCapability,
  requireMembership,
} from "../../membership";
import { requireAppCapability } from "../node-access";
import { loadTeamApp } from "../app-graph-load";
import { databaseFor, destinationExists, loadBackup } from "./target-lookup";
import { requireBackupCapability } from "./target-access";
import { executeBackup } from "./execute-backup";
import { MAX_RUNS_PER_TARGET } from "./retention";
import type { Backup, BackupRun, BackupTargetKind } from "../../types/backup";

export async function runBackup(id: string): Promise<void> {
  const { membership } = await requireMembership();
  const teamId = membership.teamId;
  const user = (await getCurrentUser())!;
  const b = await loadBackup(id, teamId);
  if (!b) throw new Error("Not found");
  await requireBackupCapability(b, "manage_backups");
  await executeBackup(teamId, user.name, {
    backupId: b.id,
    kind: b.targetKind,
    databaseId: b.databaseId,
    appId: b.appId,
    destinationId: b.destinationId,
    retentionCount: b.retentionCount,
  });
}

export async function runScheduledBackup(backup: Backup): Promise<void> {
  try {
    await executeBackup(backup.teamId, "Scheduler", {
      backupId: backup.id,
      kind: backup.targetKind,
      databaseId: backup.databaseId,
      appId: backup.appId,
      destinationId: backup.destinationId,
      retentionCount: backup.retentionCount,
    });
  } catch {}
}

async function runAdHocBackup(
  kind: BackupTargetKind,
  targetId: string,
  destinationId: string,
): Promise<BackupRun> {
  const { membership } =
    kind === "app"
      ? await requireAppCapability(targetId, "manage_backups")
      : await requireCapability("manage_backups");
  const teamId = membership.teamId;
  const user = (await getCurrentUser())!;
  if (kind === "app") {
    if (!(await loadTeamApp(targetId, teamId)))
      throw new Error("App not found");
  } else if (
    !(await reachesWholeTeam()) ||
    !(await databaseFor(targetId, teamId))
  ) {
    throw new Error("Database not found");
  }
  if (!(await destinationExists(destinationId, teamId)))
    throw new Error("Select a destination");
  return executeBackup(teamId, user.name, {
    backupId: null,
    kind,
    databaseId: kind === "database" ? targetId : null,
    appId: kind === "app" ? targetId : null,
    destinationId,
    retentionCount: MAX_RUNS_PER_TARGET,
  });
}

export function runAppBackup(
  appId: string,
  destinationId: string,
): Promise<BackupRun> {
  return runAdHocBackup("app", appId, destinationId);
}

export function runDatabaseBackup(
  databaseId: string,
  destinationId: string,
): Promise<BackupRun> {
  return runAdHocBackup("database", databaseId, destinationId);
}
