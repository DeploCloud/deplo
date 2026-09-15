import "server-only";

import { and, eq, ne } from "drizzle-orm";

import { getDb } from "../../db/client";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import { databases as databasesTable } from "../../db/schema/control-plane/databases";
import { teamProjectOrder } from "../../db/schema/control-plane/display-order";
import {
  projects as projectsTable,
  folders as foldersTable,
  environments as environmentsTable,
} from "../../db/schema/control-plane/projects";
import { defaultEnvironmentRows } from "../environments";
import { getCurrentUser } from "../../auth/current-user";
import { newId, nowIso } from "../../ids";
import {
  requireCapability,
  requireMembership,
  hasCapability,
  isInstanceAdmin,
} from "../../membership";
import { recordActivity } from "../activity";
import { reapplyNetworkAfterMove } from "../../deploy/build/reroute";
import { reapplyDatabaseNetwork } from "../databases/environment-move";
import { nameClashesOnMove } from "../name-clash";
import { mergeOrder } from "../folders";
import { normalizeHexColor } from "../../utils";
import { assertContainerNotMigrating } from "../migration-guard";
import {
  cleanName,
  counts,
  projectInTeam,
  requireReachableProject,
  summarize,
  uniqueProjectSlug,
} from "./rows";
import type { ProjectSummary } from "./rows";
import type { Project } from "../../types/team";

export async function createProject(
  name: string,
  color?: string | null,
): Promise<ProjectSummary> {
  const { teamId, userId } = await requireCapability("create_projects");
  const userName = (await getCurrentUser())?.name ?? "Someone";
  const clean = cleanName(name);
  const cleanColor = color ? normalizeHexColor(color) : null;
  const slug = await uniqueProjectSlug(teamId, clean);
  const project: Project = {
    id: newId("prc"),
    teamId,
    name: clean,
    slug,
    color: cleanColor,
    ownerUserId: userId,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  await getDb().transaction(async (tx) => {
    await tx.insert(projectsTable).values({
      id: project.id,
      teamId: project.teamId,
      name: project.name,
      slug: project.slug,
      color: project.color,
      ownerUserId: project.ownerUserId,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
    });
    const maxPos = await tx
      .select({ position: teamProjectOrder.position })
      .from(teamProjectOrder)
      .where(eq(teamProjectOrder.teamId, teamId));
    const next = maxPos.reduce((m, r) => Math.max(m, r.position + 1), 0);
    await tx
      .insert(teamProjectOrder)
      .values({ teamId, projectId: project.id, position: next });
    await tx
      .insert(environmentsTable)
      .values(defaultEnvironmentRows(project.id, project.createdAt));
  });
  await recordActivity(
    "project",
    `Created project ${project.name}`,
    userName,
    null,
    teamId,
  );
  const { folders, apps, environments } = await counts(teamId);
  return summarize(project, folders, apps, environments);
}

export async function renameProject(id: string, name: string): Promise<void> {
  const { teamId } = await requireCapability("organize_projects");
  await requireReachableProject(id, teamId);
  await assertContainerNotMigrating("project", id);
  const userName = (await getCurrentUser())?.name ?? "Someone";
  const clean = cleanName(name);
  const updated = await getDb()
    .update(projectsTable)
    .set({ name: clean, updatedAt: nowIso() })
    .where(
      and(
        eq(projectsTable.id, id),
        eq(projectsTable.teamId, teamId),
        ne(projectsTable.name, clean),
      ),
    )
    .returning({ id: projectsTable.id });
  if (updated.length === 0) {
    if (!(await projectInTeam(id, teamId)))
      throw new Error("Project not found");
    return;
  }
  await recordActivity(
    "project",
    `Renamed project to ${clean}`,
    userName,
    null,
    teamId,
  );
}

export async function setProjectColor(
  id: string,
  color: string | null,
): Promise<void> {
  const { teamId } = await requireCapability("organize_projects");
  await requireReachableProject(id, teamId);
  await assertContainerNotMigrating("project", id);
  const userName = (await getCurrentUser())?.name ?? "Someone";
  const next = color ? normalizeHexColor(color) : null;
  const rows = await getDb()
    .select()
    .from(projectsTable)
    .where(and(eq(projectsTable.id, id), eq(projectsTable.teamId, teamId)))
    .limit(1);
  const p = rows[0];
  if (!p) throw new Error("Project not found");
  if ((p.color ?? null) === next) return;
  await getDb()
    .update(projectsTable)
    .set({ color: next, updatedAt: nowIso() })
    .where(eq(projectsTable.id, id));
  await recordActivity(
    "project",
    next
      ? `Changed colour of project ${p.name}`
      : `Cleared colour of project ${p.name}`,
    userName,
    null,
    teamId,
  );
}

export async function deleteProject(
  id: string,
  opts: { deleteApps?: boolean } = {},
): Promise<void> {
  const { teamId } = await requireCapability("delete_projects");
  await requireReachableProject(id, teamId);
  await assertContainerNotMigrating("project", id);
  const userName = (await getCurrentUser())?.name ?? "Someone";
  if (opts.deleteApps) {
    const { deleteAppsIn } = await import("../apps/bulk");
    await deleteAppsIn({ projectId: id });
  }
  const moved = await getDb()
    .select({ id: appsTable.id })
    .from(appsTable)
    .where(and(eq(appsTable.teamId, teamId), eq(appsTable.projectId, id)));
  const movedDbs = await getDb()
    .select({ id: databasesTable.id })
    .from(databasesTable)
    .innerJoin(
      environmentsTable,
      eq(databasesTable.environmentId, environmentsTable.id),
    )
    .where(eq(environmentsTable.projectId, id));
  const name = await getDb().transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(projectsTable)
      .where(and(eq(projectsTable.id, id), eq(projectsTable.teamId, teamId)))
      .limit(1);
    const p = rows[0];
    if (!p) throw new Error("Project not found");
    await tx
      .update(foldersTable)
      .set({ projectId: null })
      .where(
        and(eq(foldersTable.teamId, teamId), eq(foldersTable.projectId, id)),
      );
    await tx
      .update(appsTable)
      .set({ projectId: null, environmentId: null })
      .where(and(eq(appsTable.teamId, teamId), eq(appsTable.projectId, id)));
    await tx.delete(projectsTable).where(eq(projectsTable.id, id));
    return p.name;
  });
  for (const clash of await nameClashesOnMove(
    moved.map((a) => a.id),
    { teamId, environmentId: null },
  ))
    await recordActivity(
      "app",
      `After the delete: ${clash}`,
      "Deplo",
      null,
      teamId,
    );
  await reapplyNetworkAfterMove(moved.map((a) => a.id));
  await reapplyDatabaseNetwork(movedDbs.map((d) => d.id));
  await recordActivity(
    "project",
    `Deleted project ${name}`,
    userName,
    null,
    teamId,
  );
}

export async function reorderProjects(orderedIds: string[]): Promise<void> {
  const { teamId } = await requireMembership();
  if (!(await isInstanceAdmin()) && !(await hasCapability("manage_team")))
    throw new Error("You don't have permission to reorder projects");
  await getDb().transaction(async (tx) => {
    const teamProjectIds = (
      await tx
        .select({ id: projectsTable.id })
        .from(projectsTable)
        .where(eq(projectsTable.teamId, teamId))
    ).map((r) => r.id);
    const next = mergeOrder(orderedIds, teamProjectIds);
    await tx
      .delete(teamProjectOrder)
      .where(eq(teamProjectOrder.teamId, teamId));
    if (next.length > 0)
      await tx
        .insert(teamProjectOrder)
        .values(
          next.map((projectId, position) => ({ teamId, projectId, position })),
        );
  });
}
