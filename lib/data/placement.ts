import "server-only";

import { listFolders } from "./folders";
import { listProjects } from "./projects";
import { listEnvironmentsForProject } from "./environments";
import type { OverviewPlacement } from "../overview-links";

/**
 * Resolving the Overview drill-in that a creation flow was opened from.
 *
 * The `?folder=` / `?project=` / `?env=` params travel from the Overview into
 * `/templates` and `/new` so that an app created while standing INSIDE a folder
 * (or a project environment) is created there — ADR-0009's "an app lives in one
 * place", applied at birth instead of only on a later move.
 *
 * Resolution happens against what the CALLER can see (`listFolders` is already
 * per-caller visibility-filtered), so a stale, foreign or hand-typed id quietly
 * degrades to a top-level create rather than erroring at deploy time. This is a
 * display/preselect helper, NOT the gate: `createApp` re-validates the
 * destination and requires `deploy` on the target folder.
 */
export interface ResolvedPlacement {
  /** What the UI shows, e.g. "Marketing" or "Shop · Production". */
  label: string;
  folderId: string | null;
  projectId: string | null;
  environmentId: string | null;
}

export async function resolveOverviewPlacement(
  requested: OverviewPlacement,
): Promise<ResolvedPlacement | null> {
  if (requested.folderId) {
    const folder = (await listFolders()).find((f) => f.id === requested.folderId);
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
    // No explicit environment (or one that no longer exists) ⇒ the project's
    // default, matching where a drag-into-project move lands an app.
    const environments = await listEnvironmentsForProject(project.id);
    const environment =
      (requested.environmentId
        ? environments.find((e) => e.id === requested.environmentId)
        : null) ??
      environments.find((e) => e.isDefault) ??
      environments[0] ??
      null;
    return {
      label: environment ? `${project.name} · ${environment.name}` : project.name,
      folderId: null,
      projectId: project.id,
      environmentId: environment?.id ?? null,
    };
  }
  return null;
}
