import "server-only";

import { and, inArray } from "drizzle-orm";

import { getDb } from "../../db/client";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import {
  reachesWholeTeam,
  requireCapability,
  requireMembership,
} from "../../membership";
import {
  appCapabilities,
  appCapabilitiesForTeam,
  requireAppCapability,
} from "../node-access";
import { appScopeWhere } from "../app-graph-load";
import type { BackupTargetKind } from "../../types/backup";

export async function filterBackupsToScope<
  T extends { targetKind: BackupTargetKind; appId: string | null },
>(rows: T[]): Promise<T[]> {
  if (await reachesWholeTeam()) return rows;
  const appIds = [
    ...new Set(rows.map((r) => r.appId).filter((id): id is string => !!id)),
  ];
  if (appIds.length === 0) return [];
  const reach = await appCapabilitiesForTeam(
    (await requireMembership()).teamId,
    (
      await getDb()
        .select({
          id: appsTable.id,
          folderId: appsTable.folderId,
          projectId: appsTable.projectId,
          environmentId: appsTable.environmentId,
        })
        .from(appsTable)
        .where(and(inArray(appsTable.id, appIds), appScopeWhere()))
    ).map((a) => ({
      id: a.id,
      folderId: a.folderId ?? null,
      projectId: a.projectId ?? null,
      environmentId: a.environmentId ?? null,
    })),
  );
  return rows.filter(
    (r) =>
      r.targetKind === "app" &&
      r.appId &&
      (reach.get(r.appId)?.length ?? 0) > 0,
  );
}

export async function backupTargetInScope(
  kind: BackupTargetKind,
  targetId: string,
): Promise<boolean> {
  if (await reachesWholeTeam()) return true;
  if (kind !== "app" || !targetId) return false;
  return (await appCapabilities(targetId)).length > 0;
}

export async function requireBackupCapability(
  target: { targetKind: BackupTargetKind; appId: string | null },
  cap: "manage_backups" | "restore_backups" | "delete_backups",
): Promise<void> {
  if (target.targetKind === "app" && target.appId) {
    await requireAppCapability(target.appId, cap);
    return;
  }
  if (!(await reachesWholeTeam())) throw new Error("Not found");
  await requireCapability(cap);
}
