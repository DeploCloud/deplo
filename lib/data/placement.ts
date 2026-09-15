import "server-only";

import { listFolders } from "./folders";
import { listProjects } from "./projects/read";
import { listEnvironmentsForProject } from "./environments";
import type { OverviewPlacement } from "../overview-links";

export interface ResolvedPlacement {
  label: string;
  folderId: string | null;
  projectId: string | null;
  environmentId: string | null;
}

export async function resolveOverviewPlacement(
  requested: OverviewPlacement,
): Promise<ResolvedPlacement | null> {
  if (requested.folderId) {
    const folder = (await listFolders()).find(
      (f) => f.id === requested.folderId,
    );
    return folder
      ? {
          label: folder.name,
          folderId: folder.id,
          projectId: null,
          environmentId: null,
        }
      : null;
  }
  if (requested.projectId) {
    const project = (await listProjects()).find(
      (p) => p.id === requested.projectId,
    );
    if (!project) return null;
    const environments = await listEnvironmentsForProject(project.id);
    const environment =
      (requested.environmentId
        ? environments.find((e) => e.id === requested.environmentId)
        : null) ??
      environments.find((e) => e.isDefault) ??
      environments[0] ??
      null;
    return {
      label: environment
        ? `${project.name} · ${environment.name}`
        : project.name,
      folderId: null,
      projectId: project.id,
      environmentId: environment?.id ?? null,
    };
  }
  return null;
}
