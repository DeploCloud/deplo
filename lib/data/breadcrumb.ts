import "server-only";

import { eq } from "drizzle-orm";

import { getDb } from "../db/client";
import { services as servicesTable } from "../db/schema/control-plane";
import { requireActiveTeamId } from "../membership";
import { listFolders } from "./folders";
import { listProjects } from "./projects";
import type { BreadcrumbGraph } from "../breadcrumb-model";

/**
 * The lightweight team snapshot the topbar breadcrumb navigates over: every
 * VISIBLE folder (id/name/parentId), every team service reduced to its grouping
 * links (slug/name/folder/project/environment), and the project containers by
 * name. Deliberately minimal — this runs in the dashboard layout on every page,
 * so it skips the deployment/domain preload `listServices` does (the breadcrumb
 * only needs where each service LIVES, not its status).
 *
 * Folder visibility is inherited from {@link listFolders} (owner/grant scoped);
 * an ancestor the caller can't see just ends the trail early client-side.
 */
export async function getBreadcrumbGraph(): Promise<BreadcrumbGraph> {
  const teamId = await requireActiveTeamId();
  const [folders, projects, serviceRows] = await Promise.all([
    listFolders(),
    listProjects(),
    getDb()
      .select({
        id: servicesTable.id,
        slug: servicesTable.slug,
        name: servicesTable.name,
        folderId: servicesTable.folderId,
        projectId: servicesTable.projectId,
        environmentId: servicesTable.environmentId,
      })
      .from(servicesTable)
      .where(eq(servicesTable.teamId, teamId)),
  ]);
  return {
    folders: folders.map((f) => ({
      id: f.id,
      name: f.name,
      parentId: f.parentId ?? null,
    })),
    services: serviceRows.map((s) => ({
      id: s.id,
      slug: s.slug,
      name: s.name,
      folderId: s.folderId ?? null,
      projectId: s.projectId ?? null,
      environmentId: s.environmentId ?? null,
    })),
    projects: projects.map((p) => ({ id: p.id, name: p.name })),
  };
}
