import "server-only";

import { and, eq, isNotNull } from "drizzle-orm";

import { getDb } from "../../db/client";
import {
  backups as backupsTable,
  backupRuns as backupRunsTable,
  backupDestination as destinationTable,
} from "../../db/schema/control-plane/backups";
import { databases as databasesTable } from "../../db/schema/control-plane/databases";
import { servers as serversTable } from "../../db/schema/control-plane/servers";
import { assembleBackup } from "../backup-rows";
import { loadAppGraph } from "../app-graph-load";
import type { Backup, BackupRun, BackupTargetKind } from "../../types/backup";
import type { DatabaseType } from "../../types/database";

// databaseFor - the display name of a database by id (team-scoped), or null.
export async function databaseFor(
  id: string | null,
  teamId: string,
): Promise<{ name: string; type: DatabaseType; logo: string | null } | null> {
  if (!id) return null;
  const rows = await getDb()
    .select({
      name: databasesTable.name,
      type: databasesTable.type,
      logo: databasesTable.logo,
    })
    .from(databasesTable)
    .where(and(eq(databasesTable.id, id), eq(databasesTable.teamId, teamId)))
    .limit(1);
  const row = rows[0];
  return row
    ? { name: row.name, type: row.type as DatabaseType, logo: row.logo }
    : null;
}

// databaseServerId - the owning server of a team's database `id`, or null.
export async function databaseServerId(
  id: string,
  teamId: string,
): Promise<string | null> {
  const rows = await getDb()
    .select({ serverId: databasesTable.serverId })
    .from(databasesTable)
    .where(and(eq(databasesTable.id, id), eq(databasesTable.teamId, teamId)))
    .limit(1);
  return rows[0]?.serverId ?? null;
}

// destinationExists - whether a team owns the backup destination `id`.
export async function destinationExists(
  id: string,
  teamId: string,
): Promise<boolean> {
  const rows = await getDb()
    .select({ id: destinationTable.id })
    .from(destinationTable)
    .where(
      and(eq(destinationTable.id, id), eq(destinationTable.teamId, teamId)),
    )
    .limit(1);
  return rows.length > 0;
}

// destinationNameFor - the display name of a backup destination by id (team-scoped), or "".
export async function destinationNameFor(
  id: string,
  teamId: string,
): Promise<string> {
  const rows = await getDb()
    .select({ name: destinationTable.name })
    .from(destinationTable)
    .where(
      and(eq(destinationTable.id, id), eq(destinationTable.teamId, teamId)),
    )
    .limit(1);
  return rows[0]?.name ?? "";
}

// loadBackup - one team-scoped backup schedule, assembled, or null.
export async function loadBackup(
  id: string,
  teamId: string,
): Promise<Backup | null> {
  const rows = await getDb()
    .select()
    .from(backupsTable)
    .where(and(eq(backupsTable.id, id), eq(backupsTable.teamId, teamId)))
    .limit(1);
  return rows[0] ? assembleBackup(rows[0]) : null;
}

// downloadTargetFor - what to call a run's file, and which host runs the thing it came from.
export async function downloadTargetFor(
  run: BackupRun,
  teamId: string,
): Promise<{ label: string; serverId: string | null }> {
  if (run.targetKind === "database") {
    if (!run.databaseId) return { label: "database", serverId: null };
    const rows = await getDb()
      .select({ name: databasesTable.name, serverId: databasesTable.serverId })
      .from(databasesTable)
      .where(
        and(
          eq(databasesTable.id, run.databaseId),
          eq(databasesTable.teamId, teamId),
        ),
      )
      .limit(1);
    return {
      label: rows[0]?.name ?? "database",
      serverId: rows[0]?.serverId ?? null,
    };
  }
  const app = run.appId ? await loadAppGraph(run.appId) : null;
  return { label: app?.name ?? "app", serverId: app?.serverId ?? null };
}

// runTargetWhere - the `backup_runs` WHERE selecting one target.
// On `target_id`, NOT the FKs: those are ON DELETE SET NULL, so a deleted
// target's runs stopped matching and their artifacts had nothing naming them.
export function runTargetWhere(kind: BackupTargetKind, targetId: string) {
  return and(
    eq(backupRunsTable.targetKind, kind),
    eq(backupRunsTable.targetId, targetId),
  )!;
}

// anyBackupCapableServer - any provisioned server whose agent can reach a BUCKET.
// In a sweep the workload's own agent is exactly what no longer exists.
export async function anyBackupCapableServer(): Promise<string | null> {
  const rows = await getDb()
    .select({ id: serversTable.id })
    .from(serversTable)
    .where(
      and(
        isNotNull(serversTable.agentCertFingerprint),
        // Never a migration source: it is the other platform's machine, borrowed
        // for one import. Relaying our backup traffic through it would be using
        // infrastructure that is not ours for something it never agreed to.
        eq(serversTable.importOnly, false),
      ),
    )
    .limit(1);
  return rows[0]?.id ?? null;
}
