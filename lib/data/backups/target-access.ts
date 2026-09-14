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

// filterBackupsToScope - drop the schedules a project-scoped caller can't reach. Inert when unscoped.
export async function filterBackupsToScope<
  T extends { targetKind: BackupTargetKind; appId: string | null },
>(rows: T[]): Promise<T[]> {
  // A narrowed token and a limited role reach the same part of the team; a
  // DATABASE schedule belongs to neither, so every row whose target is not an
  // app they reach is dropped.
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

// backupTargetInScope - whether a backup TARGET is reachable by this request.
// A database target never is for a principal who reaches part of the team (it
// belongs to no Project); an app target is exactly when the app is.
export async function backupTargetInScope(
  kind: BackupTargetKind,
  targetId: string,
): Promise<boolean> {
  if (await reachesWholeTeam()) return true;
  if (kind !== "app" || !targetId) return false;
  return (await appCapabilities(targetId)).length > 0;
}

// requireBackupCapability - gate a backup operation on its TARGET.
export async function requireBackupCapability(
  target: { targetKind: BackupTargetKind; appId: string | null },
  cap: "manage_backups" | "restore_backups" | "delete_backups",
): Promise<void> {
  if (target.targetKind === "app" && target.appId) {
    await requireAppCapability(target.appId, cap);
    return;
  }
  // A database belongs to no Project, and all three capabilities survive the
  // clamp, so the team-wide `requireCapability` below would let a partial-reach
  // principal through.
  if (!(await reachesWholeTeam())) throw new Error("Not found");
  await requireCapability(cap);
}
