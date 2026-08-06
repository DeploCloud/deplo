import "server-only";

import { and, eq } from "drizzle-orm";

import { getDb } from "../db/client";
import { apps as appsTable } from "../db/schema/control-plane";
import { currentMemberScope, requireActiveTeamId } from "../membership";
import { listFolders } from "./folders";
import { appScopeWhere } from "./app-graph-load";
import { appInScope } from "./node-scope";
import { listProjects } from "./projects";
import type { BreadcrumbGraph } from "../breadcrumb-model";

/**
 * The lightweight team snapshot the topbar breadcrumb navigates over: every
 * VISIBLE folder (id/name/parentId), every team app reduced to its grouping
 * links (slug/name/folder/project/environment) plus the logo its menu entry
 * wears, and the project containers by name. Deliberately minimal — this runs in
 * the dashboard layout on every page, so it skips the deployment/domain preload
 * `listApps` does (the breadcrumb only needs where each app LIVES, not its
 * status).
 *
 * Folder visibility is inherited from {@link listFolders} (owner/grant scoped);
 * an ancestor the caller can't see just ends the trail early client-side.
 */
export async function getBreadcrumbGraph(): Promise<BreadcrumbGraph> {
  const teamId = await requireActiveTeamId();
  // The apps here are queried directly rather than through `listApps`, so the
  // role scope has to be applied by hand — `appScopeWhere` answers for a token
  // only. The topbar naming every app in the team is a small leak with a large
  // surface: it is on every page.
  const roleScope = await currentMemberScope();
  const [folders, projects, appRows] = await Promise.all([
    listFolders(),
    listProjects(),
    getDb()
      .select({
        id: appsTable.id,
        slug: appsTable.slug,
        name: appsTable.name,
        folderId: appsTable.folderId,
        projectId: appsTable.projectId,
        environmentId: appsTable.environmentId,
        logo: appsTable.logo,
      })
      .from(appsTable)
      .where(and(eq(appsTable.teamId, teamId), appScopeWhere())),
  ]);
  return {
    folders: folders.map((f) => ({
      id: f.id,
      name: f.name,
      parentId: f.parentId ?? null,
    })),
    apps: appRows
      .filter((s) =>
        appInScope(roleScope, {
          id: s.id,
          folderId: s.folderId ?? null,
          projectId: s.projectId ?? null,
          environmentId: s.environmentId ?? null,
        }),
      )
      .map((s) => ({
      id: s.id,
      slug: s.slug,
      name: s.name,
      folderId: s.folderId ?? null,
      projectId: s.projectId ?? null,
      environmentId: s.environmentId ?? null,
      logo: s.logo ?? null,
    })),
    projects: projects.map((p) => ({ id: p.id, name: p.name })),
  };
}
