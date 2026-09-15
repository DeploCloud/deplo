import "server-only";

import { and, desc, eq, inArray } from "drizzle-orm";

import { getDb } from "../../db/client";
import {
  backups as backupsTable,
  backupRuns as backupRunsTable,
} from "../../db/schema/control-plane/backups";
import { assembleBackup, backupToRow } from "../backup-rows";
import { getCurrentUser } from "../../auth/current-user";
import { newId, nowIso } from "../../ids";
import {
  reachesWholeTeam,
  requireActiveTeamId,
  requireCapability,
  requireMembership,
} from "../../membership";
import { recordActivity } from "../activity";
import { requireAppCapability } from "../node-access";
import { loadAppGraph, loadTeamApp } from "../app-graph-load";
import {
  DEFAULT_SCHEDULE,
  backupTooFrequent,
  invalidScheduleMessage,
  isValidSchedule,
} from "../../schedule";
import { canonicalTimeZone } from "../../crons/cron-tz";
import {
  databaseFor,
  databaseServerId,
  destinationExists,
  destinationNameFor,
  loadBackup,
} from "./target-lookup";
import { filterBackupsToScope, requireBackupCapability } from "./target-access";
import type { Backup, BackupTargetKind } from "../../types/backup";
import type { DatabaseType } from "../../types/database";

const MAX_RETENTION_COUNT = 365;

function clampRetention(count: number): number {
  return Math.min(MAX_RETENTION_COUNT, Math.max(1, count || 7));
}

export interface BackupDTO extends Backup {
  databaseName: string | null;
  serviceName: string | null;
  destinationName: string;
  lastSizeBytes: number | null;
  databaseType: DatabaseType | null;
  databaseLogo: string | null;
  serviceLogo: string | null;
  serviceSlug: string | null;
  targetServerId: string | null;
}

async function toDTO(
  b: Backup,
  lastSizeBytes: number | null = null,
): Promise<BackupDTO> {
  const app = b.appId ? await loadAppGraph(b.appId) : null;
  const database = await databaseFor(b.databaseId, b.teamId);
  return {
    ...b,
    lastSizeBytes,
    databaseName: database?.name ?? null,
    databaseType: database?.type ?? null,
    databaseLogo: database?.logo ?? null,
    serviceName: app?.name ?? null,
    serviceLogo: app?.logo ?? null,
    serviceSlug: app?.slug ?? null,
    destinationName: await destinationNameFor(b.destinationId, b.teamId),
    targetServerId: b.appId
      ? (app?.serverId ?? null)
      : b.databaseId
        ? await databaseServerId(b.databaseId, b.teamId)
        : null,
  };
}

export async function listBackups(): Promise<BackupDTO[]> {
  const teamId = await requireActiveTeamId();
  const rows = await getDb()
    .select()
    .from(backupsTable)
    .where(eq(backupsTable.teamId, teamId))
    .orderBy(desc(backupsTable.createdAt));
  const scoped = await filterBackupsToScope(rows.map(assembleBackup));
  const sizes = await newestArtifactSizes(
    teamId,
    scoped.map((b) => b.id),
  );
  return Promise.all(scoped.map((b) => toDTO(b, sizes.get(b.id) ?? null)));
}

async function newestArtifactSizes(
  teamId: string,
  ids: string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (ids.length === 0) return out;
  const rows = await getDb()
    .selectDistinctOn([backupRunsTable.backupId], {
      backupId: backupRunsTable.backupId,
      sizeBytes: backupRunsTable.sizeBytes,
    })
    .from(backupRunsTable)
    .where(
      and(
        eq(backupRunsTable.teamId, teamId),
        eq(backupRunsTable.status, "success"),
        inArray(backupRunsTable.backupId, ids),
      ),
    )
    .orderBy(backupRunsTable.backupId, desc(backupRunsTable.seq));
  for (const r of rows) if (r.backupId) out.set(r.backupId, r.sizeBytes);
  return out;
}

function normalizeSchedule(schedule: string): string {
  const expr = (schedule || DEFAULT_SCHEDULE).trim();
  if (!isValidSchedule(expr)) throw new Error(invalidScheduleMessage(expr));
  if (backupTooFrequent(expr))
    throw new Error(
      'A backup can run at most every 15 minutes - pick specific minutes, e.g. "0,30 * * * *".',
    );
  return expr;
}

function normalizeTimezone(tz: string | null | undefined): string {
  const raw = (tz ?? "").trim();
  if (!raw) return "UTC";
  const canonical = canonicalTimeZone(raw);
  if (!canonical)
    throw new Error(`"${raw}" is not a timezone Deplo recognises`);
  return canonical;
}

export async function createBackup(input: {
  name: string;
  targetKind?: BackupTargetKind;
  databaseId: string | null;
  appId?: string | null;
  destinationId: string;
  schedule: string;
  timezone?: string | null;
  retentionCount: number;
}): Promise<BackupDTO> {
  const { membership } =
    (input.targetKind ?? "database") === "app" && input.appId
      ? await requireAppCapability(input.appId, "manage_backups")
      : await requireCapability("manage_backups");
  const teamId = membership.teamId;
  const user = (await getCurrentUser())!;
  if (!input.name.trim()) throw new Error("Name is required");
  if (!input.destinationId) throw new Error("Select a destination");
  const schedule = normalizeSchedule(input.schedule);
  const timezone = normalizeTimezone(input.timezone);

  const targetKind: BackupTargetKind = input.targetKind ?? "database";
  const appId = input.appId ?? null;
  const databaseId = input.databaseId ?? null;

  if (!(await destinationExists(input.destinationId, teamId)))
    throw new Error("Select a destination");
  if (targetKind === "database") {
    if (!databaseId) throw new Error("Select a database to back up");
    if (!(await reachesWholeTeam()) || !(await databaseFor(databaseId, teamId)))
      throw new Error("Database not found");
  } else {
    if (!appId) throw new Error("Select a project to back up");
    if (!(await loadTeamApp(appId, teamId))) throw new Error("App not found");
  }

  const b: Backup = {
    id: newId("bkp"),
    teamId,
    name: input.name.trim(),
    targetKind,
    databaseId: targetKind === "database" ? databaseId : null,
    appId: targetKind === "app" ? appId : null,
    destinationId: input.destinationId,
    schedule,
    timezone,
    retentionCount: clampRetention(input.retentionCount),
    lastRunAt: null,
    lastStatus: "never",
    enabled: true,
    createdAt: nowIso(),
  };
  await getDb().insert(backupsTable).values(backupToRow(b));
  await recordActivity(
    "backup",
    `Created backup schedule ${b.name}`,
    user.name,
    b.appId,
    teamId,
    null,
    b.databaseId,
  );
  return await toDTO(b);
}

export async function toggleBackup(
  id: string,
  enabled: boolean,
): Promise<void> {
  const teamId = await requireActiveTeamId();
  const b = await loadBackup(id, teamId);
  if (!b) throw new Error("Not found");
  await requireBackupCapability(b, "manage_backups");
  await getDb()
    .update(backupsTable)
    .set({ enabled })
    .where(and(eq(backupsTable.id, id), eq(backupsTable.teamId, teamId)));
}

export async function updateBackup(
  id: string,
  input: {
    name: string;
    destinationId: string;
    schedule: string;
    timezone?: string | null;
    retentionCount: number;
  },
): Promise<BackupDTO> {
  const { membership } = await requireMembership();
  const teamId = membership.teamId;
  const user = (await getCurrentUser())!;
  if (!input.name.trim()) throw new Error("Name is required");
  if (!input.destinationId) throw new Error("Select a destination");
  const schedule = normalizeSchedule(input.schedule);
  const timezone = normalizeTimezone(input.timezone);

  if (!(await destinationExists(input.destinationId, teamId)))
    throw new Error("Select a destination");

  const cur = await loadBackup(id, teamId);
  if (!cur) throw new Error("Not found");
  await requireBackupCapability(cur, "manage_backups");

  const updated = await getDb()
    .update(backupsTable)
    .set({
      name: input.name.trim(),
      destinationId: input.destinationId,
      schedule,
      timezone,
      retentionCount: clampRetention(input.retentionCount),
    })
    .where(and(eq(backupsTable.id, id), eq(backupsTable.teamId, teamId)))
    .returning();
  if (updated.length === 0) throw new Error("Not found");
  const b = assembleBackup(updated[0]!);
  await recordActivity(
    "backup",
    `Updated backup schedule ${b.name}`,
    user.name,
    b.appId,
    teamId,
    null,
    b.databaseId,
  );
  return await toDTO(b);
}

export async function deleteBackup(id: string): Promise<void> {
  const teamId = await requireActiveTeamId();
  const b = await loadBackup(id, teamId);
  if (!b) throw new Error("Not found");
  await requireBackupCapability(b, "manage_backups");
  await getDb()
    .delete(backupsTable)
    .where(and(eq(backupsTable.id, id), eq(backupsTable.teamId, teamId)));
}
