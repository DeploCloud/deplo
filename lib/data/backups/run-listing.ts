import "server-only";

import { and, desc, eq } from "drizzle-orm";

import { getDb } from "../../db/client";
import {
  backups as backupsTable,
  backupRuns as backupRunsTable,
} from "../../db/schema/control-plane/backups";
import { assembleBackup, assembleBackupRun } from "../backup-rows";
import { requireActiveTeamId } from "../../membership";
import { notLeftBehind, withLeftServerNames } from "./left-behind";
import { backupTargetInScope } from "./target-access";
import type { Backup, BackupRun, BackupRunStatus } from "../../types/backup";
import { placeWords, queuedNote } from "../clusters/copy-turns";
import { getServerById } from "../servers/roster";

export async function listBackupRuns(filter: {
  appId?: string;
  databaseId?: string;
}): Promise<BackupRun[]> {
  const teamId = await requireActiveTeamId();
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
  const rows = await getDb()
    .select()
    .from(backupRunsTable)
    .where(and(eq(backupRunsTable.teamId, teamId), targetWhere))
    .orderBy(desc(backupRunsTable.startedAt), desc(backupRunsTable.seq));
  return withQueued(await withLeftServerNames(rows.map(assembleBackupRun)));
}

/** A running backup that waits its turn says its place in line, and what holds it up (ADR-0043). */
async function withQueued(runs: BackupRun[]): Promise<BackupRun[]> {
  return Promise.all(
    runs.map(async (r) => {
      const w = r.status === "running" ? queuedNote(r.id) : null;
      if (!w) return r;
      const name = (await getServerById(w.serverId))?.name ?? "Another server";
      return { ...r, queued: placeWords(w, name) };
    }),
  );
}

export interface DatabaseBackupSummary {
  schedules: Backup[];
  lastRunAt: string | null;
  lastStatus: BackupRunStatus | null;
}

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
          // What a returning server left is not a backup of the database as it is now.
          notLeftBehind,
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
