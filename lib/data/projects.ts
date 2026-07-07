import "server-only";

import { and, eq, inArray, ne } from "drizzle-orm";

import { getDb } from "../db/client";
import {
  projects as projectsTable,
  folders as foldersTable,
  services as servicesTable,
  environments as environmentsTable,
  teamProjectOrder,
} from "../db/schema/control-plane";
import { defaultEnvironmentRows } from "./environments";
import { getCurrentUser } from "../auth";
import { newId, nowIso } from "../ids";
import {
  requireActiveTeamId,
  requireCapability,
  requireMembership,
  hasCapability,
  isInstanceAdmin,
} from "../membership";
import { recordActivity } from "./activity";
import { mergeOrder } from "./folders";
import { normalizeHexColor } from "../utils";
import type { Project, ServiceStatus } from "../types";

/**
 * The Project CONTAINER data layer (ADR-0008). A Project is a top-level,
 * team-scoped, folder-like grouping that owns Environments (added later) and
 * holds folders/services via their nullable `project_id`. This module mirrors
 * `folders.ts`: team-wide ordering (`team_project_order`), a `deploy`-gated CRUD,
 * and a delete that RE-PARENTS contents to the top level rather than cascading.
 *
 * NOTE (Phase 2a): visibility is team-wide (any member who can view the team sees
 * every container). The per-container owner+grants model (cloning
 * `folder-access.ts` onto `project_grants`) is a follow-up; `owner_user_id` is
 * recorded now so it can back that model without a migration.
 */

export interface ProjectSummary extends Project {
  /** Live count of folders directly in this container (derived, never stored). */
  folderCount: number;
  /** Live count of services directly in this container (derived, never stored). */
  serviceCount: number;
}

/** Cap names so one can't break the grid layout or the audit log. */
const MAX_NAME = 60;

export function cleanName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Project name is required.");
  if (trimmed.length > MAX_NAME) {
    throw new Error(`Project name must be ${MAX_NAME} characters or fewer.`);
  }
  return trimmed;
}

function assembleProject(r: typeof projectsTable.$inferSelect): Project {
  return {
    id: r.id,
    teamId: r.teamId,
    name: r.name,
    slug: r.slug,
    color: r.color ?? null,
    ownerUserId: r.ownerUserId ?? null,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

/** A URL-safe slug from a name, UNIQUE within the team (first free suffix). */
async function uniqueProjectSlug(teamId: string, name: string): Promise<string> {
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

/** Team-wide manual container order (`team_project_order`), id→rank. */
async function projectOrderRank(teamId: string): Promise<Map<string, number>> {
  const rows = await getDb()
    .select({ projectId: teamProjectOrder.projectId, position: teamProjectOrder.position })
    .from(teamProjectOrder)
    .where(eq(teamProjectOrder.teamId, teamId));
  return new Map(rows.map((r) => [r.projectId, r.position] as const));
}

/** Live folder/service counts per container, in one query each. */
async function counts(
  teamId: string,
): Promise<{ folders: Map<string, number>; services: Map<string, number> }> {
  const folders = new Map<string, number>();
  for (const r of await getDb()
    .select({ projectId: foldersTable.projectId })
    .from(foldersTable)
    .where(eq(foldersTable.teamId, teamId)))
    if (r.projectId) folders.set(r.projectId, (folders.get(r.projectId) ?? 0) + 1);
  const services = new Map<string, number>();
  for (const r of await getDb()
    .select({ projectId: servicesTable.projectId })
    .from(servicesTable)
    .where(eq(servicesTable.teamId, teamId)))
    if (r.projectId) services.set(r.projectId, (services.get(r.projectId) ?? 0) + 1);
  return { folders, services };
}

function summarize(
  p: Project,
  folders: Map<string, number>,
  services: Map<string, number>,
): ProjectSummary {
  return {
    ...p,
    folderCount: folders.get(p.id) ?? 0,
    serviceCount: services.get(p.id) ?? 0,
  };
}

/**
 * Containers in the active team, honouring the team-wide manual order and
 * falling back to newest-first — the same contract as `listFolders`/`listServices`.
 */
export async function listProjects(): Promise<ProjectSummary[]> {
  const teamId = await requireActiveTeamId();
  const rows = await getDb()
    .select()
    .from(projectsTable)
    .where(eq(projectsTable.teamId, teamId));
  const rank = await projectOrderRank(teamId);
  const { folders, services } = await counts(teamId);
  return rows
    .map(assembleProject)
    .map((p) => summarize(p, folders, services))
    .sort((a, b) => {
      const ra = rank.get(a.id) ?? Infinity;
      const rb = rank.get(b.id) ?? Infinity;
      if (ra !== rb) return ra - rb;
      return a.createdAt < b.createdAt ? 1 : -1;
    });
}

/** A container's directly-contained folders and services (for the detail page). */
export async function projectContents(projectId: string): Promise<{
  folders: { id: string; name: string; color: string | null }[];
  services: { id: string; name: string; slug: string; status: ServiceStatus }[];
}> {
  const teamId = await requireActiveTeamId();
  const folders = (
    await getDb()
      .select({ id: foldersTable.id, name: foldersTable.name, color: foldersTable.color })
      .from(foldersTable)
      .where(and(eq(foldersTable.teamId, teamId), eq(foldersTable.projectId, projectId)))
  ).map((f) => ({ id: f.id, name: f.name, color: f.color ?? null }));
  const services = (
    await getDb()
      .select({
        id: servicesTable.id,
        name: servicesTable.name,
        slug: servicesTable.slug,
        status: servicesTable.status,
      })
      .from(servicesTable)
      .where(and(eq(servicesTable.teamId, teamId), eq(servicesTable.projectId, projectId)))
  ).map((s) => ({
    id: s.id,
    name: s.name,
    slug: s.slug,
    status: s.status as ServiceStatus,
  }));
  return { folders, services };
}

/** A single container by its team-scoped slug (active team), or null. */
export async function getProjectBySlug(slug: string): Promise<Project | null> {
  const teamId = await requireActiveTeamId();
  const rows = await getDb()
    .select()
    .from(projectsTable)
    .where(and(eq(projectsTable.teamId, teamId), eq(projectsTable.slug, slug)))
    .limit(1);
  return rows[0] ? assembleProject(rows[0]) : null;
}

/** True if a container belongs to a team. */
async function projectInTeam(id: string, teamId: string): Promise<boolean> {
  const rows = await getDb()
    .select({ teamId: projectsTable.teamId })
    .from(projectsTable)
    .where(eq(projectsTable.id, id))
    .limit(1);
  return rows[0]?.teamId === teamId;
}

export async function createProject(
  name: string,
  color?: string | null,
): Promise<ProjectSummary> {
  // Same gate as creating a folder or a service: `deploy`.
  const { teamId, userId } = await requireCapability("deploy");
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
    // Seed the three default environments (Development/Preview/Production) so a
    // new container is immediately usable (ADR-0008 Phase 3).
    await tx
      .insert(environmentsTable)
      .values(defaultEnvironmentRows(project.id, project.createdAt));
  });
  await recordActivity("project", `Created project ${project.name}`, userName, null, teamId);
  const { folders, services } = await counts(teamId);
  return summarize(project, folders, services);
}

export async function renameProject(id: string, name: string): Promise<void> {
  const { teamId } = await requireCapability("deploy");
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
    if (!(await projectInTeam(id, teamId))) throw new Error("Project not found");
    return;
  }
  await recordActivity("project", `Renamed project to ${clean}`, userName, null, teamId);
}

export async function setProjectColor(
  id: string,
  color: string | null,
): Promise<void> {
  const { teamId } = await requireCapability("deploy");
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
    next ? `Changed colour of project ${p.name}` : `Cleared colour of project ${p.name}`,
    userName,
    null,
    teamId,
  );
}

/**
 * Delete a container. Nothing inside is deleted: its folders and services fall
 * back to the team top level (`project_id = NULL`, the FK default). The
 * `team_project_order` row CASCADEs on the delete.
 */
export async function deleteProject(id: string): Promise<void> {
  const { teamId } = await requireCapability("deploy");
  const userName = (await getCurrentUser())?.name ?? "Someone";
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
      .where(and(eq(foldersTable.teamId, teamId), eq(foldersTable.projectId, id)));
    await tx
      .update(servicesTable)
      .set({ projectId: null })
      .where(and(eq(servicesTable.teamId, teamId), eq(servicesTable.projectId, id)));
    await tx.delete(projectsTable).where(eq(projectsTable.id, id));
    return p.name;
  });
  // Record OUTSIDE the transaction: recordActivity opens its own connection, which
  // would deadlock against the open tx on pglite's single connection.
  await recordActivity("project", `Deleted project ${name}`, userName, null, teamId);
}

/**
 * Persist the team-wide container order. Same total-and-self-healing contract as
 * `reorderFolders`: gated on the super-user role (a team-wide setting), ids
 * sanitised to the caller's own team, omitted ids appended.
 */
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
    await tx.delete(teamProjectOrder).where(eq(teamProjectOrder.teamId, teamId));
    if (next.length > 0)
      await tx
        .insert(teamProjectOrder)
        .values(next.map((projectId, position) => ({ teamId, projectId, position })));
  });
}

/** Move a folder into a container, or back to the top level (`null`). No-op when already in place. */
export async function moveFolderToProject(
  folderId: string,
  projectId: string | null,
): Promise<void> {
  const { teamId } = await requireCapability("deploy");
  const userName = (await getCurrentUser())?.name ?? "Someone";
  const f = (
    await getDb()
      .select({ id: foldersTable.id, name: foldersTable.name, projectId: foldersTable.projectId })
      .from(foldersTable)
      .where(and(eq(foldersTable.id, folderId), eq(foldersTable.teamId, teamId)))
      .limit(1)
  )[0];
  if (!f) throw new Error("Folder not found");
  if ((f.projectId ?? null) === projectId) return;
  let msg: string;
  if (projectId) {
    const p = (
      await getDb()
        .select({ name: projectsTable.name })
        .from(projectsTable)
        .where(and(eq(projectsTable.id, projectId), eq(projectsTable.teamId, teamId)))
        .limit(1)
    )[0];
    if (!p) throw new Error("Project not found");
    msg = `Moved folder ${f.name} into project ${p.name}`;
  } else {
    msg = `Moved folder ${f.name} out of its project`;
  }
  await getDb()
    .update(foldersTable)
    .set({ projectId, updatedAt: nowIso() })
    .where(eq(foldersTable.id, folderId));
  await recordActivity("project", msg, userName, null, teamId);
}

/** Move a service into a container, or back to the top level (`null`). No-op when already in place. */
export async function moveServiceToProject(
  serviceId: string,
  projectId: string | null,
): Promise<void> {
  const { teamId } = await requireCapability("deploy");
  const userName = (await getCurrentUser())?.name ?? "Someone";
  const s = (
    await getDb()
      .select({ id: servicesTable.id, name: servicesTable.name, projectId: servicesTable.projectId })
      .from(servicesTable)
      .where(and(eq(servicesTable.id, serviceId), eq(servicesTable.teamId, teamId)))
      .limit(1)
  )[0];
  if (!s) throw new Error("Service not found");
  if ((s.projectId ?? null) === projectId) return;
  let msg: string;
  if (projectId) {
    const p = (
      await getDb()
        .select({ name: projectsTable.name })
        .from(projectsTable)
        .where(and(eq(projectsTable.id, projectId), eq(projectsTable.teamId, teamId)))
        .limit(1)
    )[0];
    if (!p) throw new Error("Project not found");
    msg = `Moved ${s.name} into project ${p.name}`;
  } else {
    msg = `Moved ${s.name} out of its project`;
  }
  await getDb()
    .update(servicesTable)
    .set({ projectId, updatedAt: nowIso() })
    .where(eq(servicesTable.id, serviceId));
  await recordActivity("project", msg, userName, serviceId, teamId);
}
