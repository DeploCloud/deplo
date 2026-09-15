import "server-only";

import { cache } from "@/lib/request-cache";
import { and, eq } from "drizzle-orm";

import { getDb } from "../../db/client";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import { teamProjectOrder } from "../../db/schema/control-plane/display-order";
import {
  projects as projectsTable,
  folders as foldersTable,
} from "../../db/schema/control-plane/projects";
import { currentMemberScope, requireActiveTeamId } from "../../membership";
import { inProjectScope } from "../../auth/request-context";
import { appInScope, folderInScope, projectInScope } from "../node-scope";
import { assembleProject, counts, summarize } from "./rows";
import type { ProjectSummary } from "./rows";
import type { AppStatus } from "../../types/app";
import type { Project } from "../../types/team";

async function projectOrderRank(teamId: string): Promise<Map<string, number>> {
  const rows = await getDb()
    .select({
      projectId: teamProjectOrder.projectId,
      position: teamProjectOrder.position,
    })
    .from(teamProjectOrder)
    .where(eq(teamProjectOrder.teamId, teamId));
  return new Map(rows.map((r) => [r.projectId, r.position] as const));
}

export const listProjects = cache(async function listProjects(): Promise<
  ProjectSummary[]
> {
  const teamId = await requireActiveTeamId();
  const roleScope = await currentMemberScope();
  const rows = (
    await getDb()
      .select()
      .from(projectsTable)
      .where(eq(projectsTable.teamId, teamId))
  ).filter((p) => inProjectScope(p.id) && projectInScope(roleScope, p.id));
  const rank = await projectOrderRank(teamId);
  const { folders, apps, environments } = await counts(teamId);
  return rows
    .map(assembleProject)
    .map((p) => summarize(p, folders, apps, environments))
    .sort((a, b) => {
      const ra = rank.get(a.id) ?? Infinity;
      const rb = rank.get(b.id) ?? Infinity;
      if (ra !== rb) return ra - rb;
      return a.createdAt < b.createdAt ? 1 : -1;
    });
});

export async function projectContents(projectId: string): Promise<{
  folders: { id: string; name: string; color: string | null }[];
  apps: { id: string; name: string; slug: string; status: AppStatus }[];
}> {
  const teamId = await requireActiveTeamId();
  const scope = await currentMemberScope();
  if (!inProjectScope(projectId)) return { folders: [], apps: [] };
  if (!projectInScope(scope, projectId)) return { folders: [], apps: [] };
  const folders = (
    await getDb()
      .select({
        id: foldersTable.id,
        name: foldersTable.name,
        color: foldersTable.color,
      })
      .from(foldersTable)
      .where(
        and(
          eq(foldersTable.teamId, teamId),
          eq(foldersTable.projectId, projectId),
        ),
      )
  )
    .filter((f) => folderInScope(scope, f.id))
    .map((f) => ({ id: f.id, name: f.name, color: f.color ?? null }));
  const apps = (
    await getDb()
      .select({
        id: appsTable.id,
        name: appsTable.name,
        slug: appsTable.slug,
        status: appsTable.status,
        folderId: appsTable.folderId,
        projectId: appsTable.projectId,
        environmentId: appsTable.environmentId,
      })
      .from(appsTable)
      .where(
        and(eq(appsTable.teamId, teamId), eq(appsTable.projectId, projectId)),
      )
  )
    .filter((s) =>
      appInScope(scope, {
        id: s.id,
        folderId: s.folderId,
        projectId: s.projectId,
        environmentId: s.environmentId,
      }),
    )
    .map((s) => ({
      id: s.id,
      name: s.name,
      slug: s.slug,
      status: s.status as AppStatus,
    }));
  return { folders, apps };
}

export async function getProjectBySlug(slug: string): Promise<Project | null> {
  const teamId = await requireActiveTeamId();
  const rows = await getDb()
    .select()
    .from(projectsTable)
    .where(and(eq(projectsTable.teamId, teamId), eq(projectsTable.slug, slug)))
    .limit(1);
  return rows[0] &&
    inProjectScope(rows[0].id) &&
    projectInScope(await currentMemberScope(), rows[0].id)
    ? assembleProject(rows[0])
    : null;
}
