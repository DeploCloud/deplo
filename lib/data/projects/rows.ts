import "server-only";

import { and, eq } from "drizzle-orm";

import { getDb } from "../../db/client";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import {
  projects as projectsTable,
  folders as foldersTable,
  environments as environmentsTable,
} from "../../db/schema/control-plane/projects";
import { newId } from "../../ids";
import { currentMemberScope } from "../../membership";
import { inProjectScope } from "../../auth/request-context";
import { projectInScope } from "../node-scope";
import { appScopeWhere } from "../app-graph-load";
import type { Project } from "../../types/team";

export interface ProjectSummary extends Project {
  // Legacy: ADR-0009 no longer files folders into projects, kept for older rows.
  folderCount: number;
  // Apps across every environment, plus any inside a legacy folder-in-project subtree.
  appCount: number;
  environmentCount: number;
}

// Cap names so one can't break the grid layout or the audit log.
const MAX_NAME = 60;

export function cleanName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Project name is required.");
  if (trimmed.length > MAX_NAME) {
    throw new Error(`Project name must be ${MAX_NAME} characters or fewer.`);
  }
  return trimmed;
}

export function assembleProject(r: typeof projectsTable.$inferSelect): Project {
  return {
    id: r.id,
    teamId: r.teamId,
    name: r.name,
    slug: r.slug,
    color: r.color ?? null,
    ownerUserId: r.ownerUserId ?? null,
    migrationRunId: r.migrationRunId ?? null,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

// uniqueProjectSlug - a URL-safe slug from a name, unique within the team.
export async function uniqueProjectSlug(
  teamId: string,
  name: string,
): Promise<string> {
  const base =
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || `project-${newId("").slice(1, 6)}`;
  const taken = new Set(
    (
      await getDb()
        .select({ slug: projectsTable.slug })
        .from(projectsTable)
        .where(eq(projectsTable.teamId, teamId))
    ).map((r) => r.slug),
  );
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

// counts - live folder/app/environment counts per container, one query each.
export async function counts(teamId: string): Promise<{
  folders: Map<string, number>;
  apps: Map<string, number>;
  environments: Map<string, number>;
}> {
  const folderRows = await getDb()
    .select({
      id: foldersTable.id,
      parentId: foldersTable.parentId,
      projectId: foldersTable.projectId,
    })
    .from(foldersTable)
    .where(eq(foldersTable.teamId, teamId));
  const folders = new Map<string, number>();
  for (const r of folderRows)
    if (r.projectId)
      folders.set(r.projectId, (folders.get(r.projectId) ?? 0) + 1);
  // An app counts DIRECTLY (its own project_id, ADR-0009) or through a LEGACY
  // folder-in-project row: filing into a folder clears the app's own project link.
  const folderById = new Map(folderRows.map((r) => [r.id, r] as const));
  const projectOfFolder = (folderId: string): string | null => {
    const seen = new Set<string>();
    let cur = folderById.get(folderId);
    while (cur && !seen.has(cur.id)) {
      if (cur.projectId) return cur.projectId;
      seen.add(cur.id);
      cur = cur.parentId ? folderById.get(cur.parentId) : undefined;
    }
    return null;
  };
  const apps = new Map<string, number>();
  for (const r of await getDb()
    .select({
      projectId: appsTable.projectId,
      folderId: appsTable.folderId,
    })
    .from(appsTable)
    .where(and(eq(appsTable.teamId, teamId), appScopeWhere()))) {
    const pid =
      r.projectId ?? (r.folderId ? projectOfFolder(r.folderId) : null);
    if (pid) apps.set(pid, (apps.get(pid) ?? 0) + 1);
  }
  // Environments are project-scoped (no team column); count via the join.
  const environments = new Map<string, number>();
  for (const r of await getDb()
    .select({ projectId: environmentsTable.projectId })
    .from(environmentsTable)
    .innerJoin(projectsTable, eq(environmentsTable.projectId, projectsTable.id))
    .where(eq(projectsTable.teamId, teamId)))
    environments.set(r.projectId, (environments.get(r.projectId) ?? 0) + 1);
  return { folders, apps, environments };
}

export function summarize(
  p: Project,
  folders: Map<string, number>,
  apps: Map<string, number>,
  environments: Map<string, number>,
): ProjectSummary {
  return {
    ...p,
    folderCount: folders.get(p.id) ?? 0,
    appCount: apps.get(p.id) ?? 0,
    environmentCount: environments.get(p.id) ?? 0,
  };
}

// projectInTeam - true if a container belongs to a team, and is in the caller's scope.
export async function projectInTeam(
  id: string,
  teamId: string,
): Promise<boolean> {
  const rows = await getDb()
    .select({ teamId: projectsTable.teamId })
    .from(projectsTable)
    .where(eq(projectsTable.id, id))
    .limit(1);
  return rows[0]?.teamId === teamId && inProjectScope(id);
}

// requireReachableProject - a member limited to part of the team must not rename,
// recolour or delete a container outside it, and the refusal must not confirm the id.
export async function requireReachableProject(
  id: string,
  teamId: string,
): Promise<void> {
  if (
    !(await projectInTeam(id, teamId)) ||
    !projectInScope(await currentMemberScope(), id)
  )
    throw new Error("Project not found");
}
