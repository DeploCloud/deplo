import "server-only";

import { and, desc, eq } from "drizzle-orm";

import { getDb } from "../../db/client";
import {
  backups as backupsTable,
  backupRuns as backupRunsTable,
} from "../../db/schema/control-plane/backups";
import { assembleBackup, assembleBackupRun } from "../backup-rows";
import { requireActiveTeamId } from "../../membership";
import { backupTargetInScope } from "./target-access";
import type { Backup, BackupRun, BackupRunStatus } from "../../types/backup";

// listBackupRuns - the runs for a target's artifact list, newest first. Exactly
// one of `appId` / `databaseId` is given; team-scoped.
export async function listBackupRuns(filter: {
  appId?: string;
  databaseId?: string;
}): Promise<BackupRun[]> {
  const teamId = await requireActiveTeamId();
  // A run history is reachable only through a target the caller can reach: an
  // out-of-scope app, or any database, yields nothing for a scoped token.
  if (
    !(await backupTargetInScope(
      filter.appId ? "app" : "database",
      filter.appId ?? filter.databaseId ?? "",
    ))
  )
    return [];
  const targetWhere = filter.appId
    ? eq(backupRunsTable.appId, filter.appId)
    : filter.databaseId
      ? eq(backupRunsTable.databaseId, filter.databaseId)
      : null;
  if (!targetWhere) return [];
  // (started_at, seq) DESC is deterministic under a same-millisecond tie.
  const rows = await getDb()
    .select()
    .from(backupRunsTable)
    .where(and(eq(backupRunsTable.teamId, teamId), targetWhere))
    .orderBy(desc(backupRunsTable.startedAt), desc(backupRunsTable.seq));
  return rows.map(assembleBackupRun);
}

// DatabaseBackupSummary - what backs a database up, for the one card the overview shows.
export interface DatabaseBackupSummary {
  // This database's schedules, newest first. Empty ⇒ nothing backs it up.
  schedules: Backup[];
  // The newest run of ANY kind, scheduled or ad-hoc.
  lastRunAt: string | null;
  lastStatus: BackupRunStatus | null;
}

// getDatabaseBackupSummary - a database's backup state in one read. The runs query
// is not redundant with `Backup.lastRunAt`, which only tracks SCHEDULED runs: an
// ad-hoc run carries `backupId: null`.
export async function getDatabaseBackupSummary(
  databaseId: string,
): Promise<DatabaseBackupSummary> {
  const empty: DatabaseBackupSummary = {
    schedules: [],
    lastRunAt: null,
    lastStatus: null,
  };
  const teamId = await requireActiveTeamId();
  if (!(await backupTargetInScope("database", databaseId))) return empty;

  const db = getDb();
  const [scheduleRows, runRows] = await Promise.all([
    // assembleBackup, not toDTO: the DTO resolves an app graph, a database and a
    // destination name PER ROW, and this runs on the most-visited database page.
    db
      .select()
      .from(backupsTable)
      .where(
        and(
          eq(backupsTable.teamId, teamId),
          eq(backupsTable.databaseId, databaseId),
        ),
      )
      .orderBy(desc(backupsTable.createdAt)),
    db
      .select()
      .from(backupRunsTable)
      .where(
        and(
          eq(backupRunsTable.teamId, teamId),
          eq(backupRunsTable.databaseId, databaseId),
        ),
      )
      .orderBy(desc(backupRunsTable.startedAt), desc(backupRunsTable.seq))
      .limit(1),
  ]);

  const last = runRows[0];
  return {
    schedules: scheduleRows.map(assembleBackup),
    lastRunAt: last?.startedAt ?? null,
    lastStatus: (last?.status as BackupRunStatus | undefined) ?? null,
  };
}
