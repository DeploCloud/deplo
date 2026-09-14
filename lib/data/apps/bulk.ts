import "server-only";

import { and, eq, inArray, or } from "drizzle-orm";

import { getDb } from "../../db/client";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import { folders as foldersTable } from "../../db/schema/control-plane/projects";
import { requireMembership } from "../../membership";
import { inAppScope } from "../../auth/request-context";
import { appCapabilitiesForTeam } from "../node-access";
import { descendantFolderIds } from "../folders";
import { redeploy } from "../deployments/stack-actions";
import { mapLimit } from "../../utils";
import { startAppsDelete } from "./delete";
import { errMsg, startApp, stopApp } from "./lifecycle";

// AppScope: which container a whole-contents action runs over - a folder or a project.
export type AppScope = { folderId?: string | null; projectId?: string | null };

// Every app in a folder's whole subtree, or in a project. Team-scoped rows only: the caller applies its own reach.
async function appsInScope(
  teamId: string,
  scope: AppScope,
): Promise<
  {
    id: string;
    folderId: string | null;
    projectId: string | null;
    environmentId: string | null;
  }[]
> {
  if (!scope.folderId && !scope.projectId)
    throw new Error("Pick a folder or a project to act on");
  const tree = await getDb()
    .select({
      id: foldersTable.id,
      parentId: foldersTable.parentId,
      projectId: foldersTable.projectId,
    })
    .from(foldersTable)
    .where(eq(foldersTable.teamId, teamId));

  // A project's apps are its own plus anything in a LEGACY folder filed under it - the two sources its tile counts.
  const folderIds = scope.folderId
    ? [...descendantFolderIds(scope.folderId, tree)]
    : // A project's apps are its own (ADR-0009's per-environment membership),
      tree
        .filter((f) => f.projectId === scope.projectId)
        .flatMap((f) => [...descendantFolderIds(f.id, tree)]);
  return getDb()
    .select({
      id: appsTable.id,
      folderId: appsTable.folderId,
      projectId: appsTable.projectId,
      environmentId: appsTable.environmentId,
    })
    .from(appsTable)
    .where(
      and(
        eq(appsTable.teamId, teamId),
        scope.folderId
          ? inArray(appsTable.folderId, folderIds)
          : folderIds.length > 0
            ? or(
                eq(appsTable.projectId, scope.projectId!),
                inArray(appsTable.folderId, folderIds),
              )
            : eq(appsTable.projectId, scope.projectId!),
      ),
    );
}

// deleteAppsIn runs BEFORE the container itself goes (ADR-0016), gated per app on `delete_apps`.
export async function deleteAppsIn(scope: AppScope): Promise<number> {
  const { membership } = await requireMembership();
  const rows = await appsInScope(membership.teamId, scope);
  if (rows.length === 0) return 0;
  return startAppsDelete(rows.map((r) => r.id));
}

// BulkAppAction: the lifecycle actions a folder or a project runs over all of its apps at once.
export type BulkAppAction = "start" | "stop" | "restart" | "redeploy";

// bulkAppAction only fans out to the per-app functions the single-app menu calls, so the gates and the trail are identical.
export async function bulkAppAction(
  action: BulkAppAction,
  scope: AppScope,
): Promise<{ ok: number; failed: number; error: string | null }> {
  const { membership } = await requireMembership();
  const teamId = membership.teamId;

  const rows = await appsInScope(teamId, scope);

  // Token scope first, then per-app reach: the same two filters `listApps` applies.
  const scoped = rows.filter((p) => inAppScope(p));
  const reach = await appCapabilitiesForTeam(
    teamId,
    scoped.map((p) => ({
      id: p.id,
      folderId: p.folderId ?? null,
      projectId: p.projectId ?? null,
      environmentId: p.environmentId ?? null,
    })),
  );
  const targets = scoped
    .filter((p) => (reach.get(p.id)?.length ?? 0) > 0)
    .map((p) => p.id);

  let ok = 0;
  let failed = 0;
  let error: string | null = null;
  await mapLimit(targets, 4, async (id) => {
    try {
      if (action === "redeploy") await redeploy(id);
      else {
        if (action !== "start") await stopApp(id);
        if (action !== "stop") await startApp(id);
      }
      ok++;
    } catch (e) {
      failed++;
      error ??= errMsg(e);
    }
  });
  return { ok, failed, error };
}
