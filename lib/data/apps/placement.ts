import "server-only";

import { and, eq } from "drizzle-orm";

import { getDb } from "../../db/client";
import {
  environments as environmentsTable,
  folders as foldersTable,
  projects as projectsTable,
} from "../../db/schema/control-plane/projects";
import { currentMemberScope, requireCapability } from "../../membership";
import { inFolderScope, inProjectScope } from "../../auth/request-context";
import { appInScope, folderInScope } from "../node-scope";
import { requireFolderCapability } from "../folder-access";
import { requireNodeCapability } from "../node-access";
import { defaultEnvironmentFor } from "../projects/placement";

export interface AppPlacementInput {
  folderId?: string | null;
  projectId?: string | null;
  environmentId?: string | null;
}

export async function resolveNewAppPlacement(
  input: AppPlacementInput,
  teamId: string,
): Promise<{
  folderId: string | null;
  projectId: string | null;
  environmentId: string | null;
}> {
  const placement = await resolvePlacement(input, teamId);

  const roleScope = await currentMemberScope();
  if (placement.folderId) {
    if (
      !inFolderScope(placement.folderId) ||
      !folderInScope(roleScope, placement.folderId)
    )
      throw new Error("Folder not found");
  } else if (
    !inProjectScope(placement.projectId) ||
    !appInScope(roleScope, {
      id: "",
      folderId: null,
      projectId: placement.projectId,
      environmentId: placement.environmentId,
    })
  ) {
    throw new Error("Project not found");
  }
  return placement;
}

export async function resolvePlacement(
  input: AppPlacementInput,
  teamId: string,
): Promise<{
  folderId: string | null;
  projectId: string | null;
  environmentId: string | null;
}> {
  if (input.folderId) {
    const f = (
      await getDb()
        .select({ id: foldersTable.id })
        .from(foldersTable)
        .where(
          and(
            eq(foldersTable.id, input.folderId),
            eq(foldersTable.teamId, teamId),
          ),
        )
        .limit(1)
    )[0];
    if (!f) throw new Error("Folder not found");
    await requireFolderCapability(f.id, "create_apps");
    return { folderId: f.id, projectId: null, environmentId: null };
  }
  if (input.environmentId) {
    const env = (
      await getDb()
        .select({
          id: environmentsTable.id,
          projectId: environmentsTable.projectId,
          teamId: projectsTable.teamId,
        })
        .from(environmentsTable)
        .innerJoin(
          projectsTable,
          eq(environmentsTable.projectId, projectsTable.id),
        )
        .where(eq(environmentsTable.id, input.environmentId))
        .limit(1)
    )[0];
    if (!env || env.teamId !== teamId) throw new Error("Environment not found");

    if (input.projectId && input.projectId !== env.projectId)
      throw new Error("Environment not found");
    await requireNodeCapability(
      { kind: "project", id: env.projectId },
      "create_apps",
    );
    return { folderId: null, projectId: env.projectId, environmentId: env.id };
  }
  if (input.projectId) {
    const p = (
      await getDb()
        .select({ id: projectsTable.id })
        .from(projectsTable)
        .where(
          and(
            eq(projectsTable.id, input.projectId),
            eq(projectsTable.teamId, teamId),
          ),
        )
        .limit(1)
    )[0];
    if (!p) throw new Error("Project not found");
    await requireNodeCapability({ kind: "project", id: p.id }, "create_apps");
    const env = await defaultEnvironmentFor(p.id);
    return { folderId: null, projectId: p.id, environmentId: env?.id ?? null };
  }

  await requireCapability("create_apps");
  return { folderId: null, projectId: null, environmentId: null };
}
