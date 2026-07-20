import "server-only";

import { cache } from "react";
import { and, eq, ne } from "drizzle-orm";

import { getDb } from "../db/client";
import {
  projects as projectsTable,
  folders as foldersTable,
  apps as appsTable,
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
import { requireFolderCapabilityForApp } from "./folder-access";
import { mergeOrder } from "./folders";
import { normalizeHexColor } from "../utils";
import type { Project, AppStatus } from "../types";

/**
 * The Project data layer (ADR-0008, remodeled per ADR-0009). A Project is a
 * top-level, team-scoped ADVANCED FOLDER whose contents live per Environment:
 * an app inside a project belongs to exactly one of its environments
 * (`apps.environment_id`; `project_id` is the derived project link).
 * Folders never live inside projects. This module mirrors `folders.ts`:
 * team-wide ordering (`team_project_order`), a `deploy`-gated CRUD, and a
 * delete that RE-PARENTS contents to the top level rather than cascading.
 *
 * NOTE (Phase 2a): visibility is team-wide (any member who can view the team sees
 * every project). The per-project owner+grants model (cloning
 * `folder-access.ts` onto `project_grants`) is a follow-up; `owner_user_id` is
 * recorded now so it can back that model without a migration.
 */

export interface ProjectSummary extends Project {
  /** Live count of folders directly in this container (derived, never stored).
   *  Legacy — the ADR-0009 model no longer files folders into projects; kept for
   *  rows written before the pivot. */
  folderCount: number;
  /** Live count of apps in this project, across all environments —
   *  including apps living anywhere inside a legacy folder-in-project
   *  subtree (pre-ADR-0009 rows), which carry no `project_id` of their own. */
  appCount: number;
  /** Live count of this project's environments. */
  environmentCount: number;
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

/** Live folder/app/environment counts per container, in one query each. */
async function counts(
  teamId: string,
): Promise<{
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
    if (r.projectId) folders.set(r.projectId, (folders.get(r.projectId) ?? 0) + 1);
  // An app counts toward a project either DIRECTLY (its own `project_id` —
  // the ADR-0009 per-environment membership) or through a LEGACY
  // folder-in-project row: filing into a folder clears the app's own
  // project link, so an app anywhere inside a project-filed folder subtree
  // is credited by walking its folder's parent chain to the nearest
  // project-linked ancestor (cycle-safe, like the folder tree walks).
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
    .where(eq(appsTable.teamId, teamId))) {
    const pid = r.projectId ?? (r.folderId ? projectOfFolder(r.folderId) : null);
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

function summarize(
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

/**
 * Containers in the active team, honouring the team-wide manual order and
 * falling back to newest-first — the same contract as `listFolders`/`listApps`.
 */
export const listProjects = cache(async function listProjects(): Promise<
  ProjectSummary[]
> {
  const teamId = await requireActiveTeamId();
  const rows = await getDb()
    .select()
    .from(projectsTable)
    .where(eq(projectsTable.teamId, teamId));
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

/** A container's directly-contained folders and apps (for the detail page). */
export async function projectContents(projectId: string): Promise<{
  folders: { id: string; name: string; color: string | null }[];
  apps: { id: string; name: string; slug: string; status: AppStatus }[];
}> {
  const teamId = await requireActiveTeamId();
  const folders = (
    await getDb()
      .select({ id: foldersTable.id, name: foldersTable.name, color: foldersTable.color })
      .from(foldersTable)
      .where(and(eq(foldersTable.teamId, teamId), eq(foldersTable.projectId, projectId)))
  ).map((f) => ({ id: f.id, name: f.name, color: f.color ?? null }));
  const apps = (
    await getDb()
      .select({
        id: appsTable.id,
        name: appsTable.name,
        slug: appsTable.slug,
        status: appsTable.status,
      })
      .from(appsTable)
      .where(and(eq(appsTable.teamId, teamId), eq(appsTable.projectId, projectId)))
  ).map((s) => ({
    id: s.id,
    name: s.name,
    slug: s.slug,
    status: s.status as AppStatus,
  }));
  return { folders, apps };
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
  // Same gate as creating a folder or an app: `deploy`.
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
  const { folders, apps, environments } = await counts(teamId);
  return summarize(project, folders, apps, environments);
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
 * Delete a container. Nothing inside is deleted: its folders and apps fall
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
      .update(appsTable)
      .set({ projectId: null, environmentId: null })
      .where(and(eq(appsTable.teamId, teamId), eq(appsTable.projectId, id)));
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

/** A project's default environment (falls back to the first by position). */
async function defaultEnvironmentFor(
  projectId: string,
): Promise<{ id: string; name: string } | null> {
  const rows = await getDb()
    .select({
      id: environmentsTable.id,
      name: environmentsTable.name,
      isDefault: environmentsTable.isDefault,
      position: environmentsTable.position,
    })
    .from(environmentsTable)
    .where(eq(environmentsTable.projectId, projectId));
  if (rows.length === 0) return null;
  const def =
    rows.find((e) => e.isDefault) ??
    [...rows].sort((a, b) => a.position - b.position)[0];
  return { id: def.id, name: def.name };
}

/**
 * Move an app into a project — landing in the project's DEFAULT environment
 * (ADR-0009: a project's contents live per environment) — or back to the top
 * level (`null`). Entering a project also leaves any folder (one home only).
 * No-op when already in that project.
 */
export async function moveAppToProject(
  appId: string,
  projectId: string | null,
): Promise<void> {
  const { teamId } = await requireCapability("deploy");
  const userName = (await getCurrentUser())?.name ?? "Someone";
  const s = (
    await getDb()
      .select({ id: appsTable.id, name: appsTable.name, projectId: appsTable.projectId })
      .from(appsTable)
      .where(and(eq(appsTable.id, appId), eq(appsTable.teamId, teamId)))
      .limit(1)
  )[0];
  if (!s) throw new Error("App not found");
  // Entering a project also pulls the app out of any folder (one home only) —
  // that eviction needs `deploy` on the source folder too, same as
  // moveAppToFolder. A no-op for a top-level app.
  await requireFolderCapabilityForApp(appId, "deploy");
  if ((s.projectId ?? null) === projectId) return;
  let msg: string;
  let environmentId: string | null = null;
  if (projectId) {
    const p = (
      await getDb()
        .select({ name: projectsTable.name })
        .from(projectsTable)
        .where(and(eq(projectsTable.id, projectId), eq(projectsTable.teamId, teamId)))
        .limit(1)
    )[0];
    if (!p) throw new Error("Project not found");
    const env = await defaultEnvironmentFor(projectId);
    environmentId = env?.id ?? null;
    msg = env
      ? `Moved ${s.name} into project ${p.name} (${env.name})`
      : `Moved ${s.name} into project ${p.name}`;
  } else {
    msg = `Moved ${s.name} out of its project`;
  }
  await getDb()
    .update(appsTable)
    .set({
      projectId,
      environmentId,
      ...(projectId ? { folderId: null } : {}),
      updatedAt: nowIso(),
    })
    .where(eq(appsTable.id, appId));
  await recordActivity("project", msg, userName, appId, teamId);
}

/**
 * Move an app into a SPECIFIC environment of a project (the dropdown's
 * "Move to environment" action). The app's project follows the environment;
 * entering also leaves any folder. No-op when already there.
 */
export async function moveAppToEnvironment(
  appId: string,
  environmentId: string,
): Promise<void> {
  const { teamId } = await requireCapability("deploy");
  const userName = (await getCurrentUser())?.name ?? "Someone";
  const s = (
    await getDb()
      .select({
        id: appsTable.id,
        name: appsTable.name,
        environmentId: appsTable.environmentId,
      })
      .from(appsTable)
      .where(and(eq(appsTable.id, appId), eq(appsTable.teamId, teamId)))
      .limit(1)
  )[0];
  if (!s) throw new Error("App not found");
  // Entering an environment also leaves any folder — that eviction needs
  // `deploy` on the source folder too, same as moveAppToFolder. A no-op for a
  // top-level app.
  await requireFolderCapabilityForApp(appId, "deploy");
  if ((s.environmentId ?? null) === environmentId) return;
  const env = (
    await getDb()
      .select({
        id: environmentsTable.id,
        name: environmentsTable.name,
        projectId: environmentsTable.projectId,
        projectName: projectsTable.name,
        teamId: projectsTable.teamId,
      })
      .from(environmentsTable)
      .innerJoin(projectsTable, eq(environmentsTable.projectId, projectsTable.id))
      .where(eq(environmentsTable.id, environmentId))
      .limit(1)
  )[0];
  if (!env || env.teamId !== teamId) throw new Error("Environment not found");
  await getDb()
    .update(appsTable)
    .set({
      projectId: env.projectId,
      environmentId: env.id,
      folderId: null,
      updatedAt: nowIso(),
    })
    .where(eq(appsTable.id, appId));
  await recordActivity(
    "project",
    `Moved ${s.name} to ${env.name} in project ${env.projectName}`,
    userName,
    appId,
    teamId,
  );
}
