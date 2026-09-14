import "server-only";

import { cache } from "@/lib/request-cache";
import { and, eq, inArray } from "drizzle-orm";

import { getDb } from "../db/client";
import {
  appGrants,
  folderGrants,
  memberships as membershipsTable,
  projectGrants,
  teamRoles as teamRolesTable,
  teamRoleScopeApps,
  teamRoleScopeEnvironments,
  teamRoleScopeFolders,
  teamRoleScopeProjects,
} from "../db/schema/control-plane/access-control";
import { apps as appsTable } from "../db/schema/control-plane/apps";
import {
  environments as environmentsTable,
  folders as foldersTable,
  projects as projectsTable,
} from "../db/schema/control-plane/projects";

// NodeScope is what a scope names; null anywhere below means unrestricted.
export interface NodeScope {
  projectIds: string[];
  environmentIds: string[];
  folderIds: string[];
  appIds: string[];
  appProjectIds: string[];
}

// expandFolders returns every folder a scope reaches, plus the projects those folders sit in.
export async function expandFolders(
  teamIds: string[],
  ticked: string[],
  scopedProjectIds: string[],
): Promise<{ folderIds: string[]; folderProjectIds: string[] }> {
  if (
    teamIds.length === 0 ||
    (ticked.length === 0 && scopedProjectIds.length === 0)
  )
    return { folderIds: [], folderProjectIds: [] };
  const rows = await getDb()
    .select({
      id: foldersTable.id,
      parentId: foldersTable.parentId,
      projectId: foldersTable.projectId,
    })
    .from(foldersTable)
    .where(inArray(foldersTable.teamId, teamIds));

  const childrenOf = new Map<string, string[]>();
  for (const f of rows)
    if (f.parentId)
      childrenOf.set(f.parentId, [...(childrenOf.get(f.parentId) ?? []), f.id]);

  const projects = new Set(scopedProjectIds);
  const roots = [
    ...ticked,
    ...rows
      .filter((f) => f.projectId && projects.has(f.projectId))
      .map((f) => f.id),
  ];

  const reached = new Set<string>();
  const stack = [...roots];
  while (stack.length) {
    const id = stack.pop()!;
    if (reached.has(id)) continue;
    reached.add(id);
    for (const child of childrenOf.get(id) ?? []) stack.push(child);
  }

  const byId = new Map(rows.map((f) => [f.id, f] as const));
  const folderProjectIds = [
    ...new Set(
      ticked
        .map((id) => byId.get(id)?.projectId)
        .filter((id): id is string => id != null),
    ),
  ];
  return { folderIds: [...reached], folderProjectIds };
}

// memberScopeFor is this person's reach in a team, or null for the whole of it.
export const memberScopeFor = cache(async function memberScopeFor(
  userId: string,
  teamId: string,
): Promise<NodeScope | null> {
  const db = getDb();
  const row = (
    await db
      .select({
        roleId: teamRolesTable.id,
        scoped: teamRolesTable.scoped,
        granular: membershipsTable.granular,
      })
      .from(membershipsTable)
      // LEFT, not inner: a granular membership carries its own reach with or without a role.
      .leftJoin(teamRolesTable, eq(teamRolesTable.id, membershipsTable.roleId))
      .where(
        and(
          eq(membershipsTable.userId, userId),
          eq(membershipsTable.teamId, teamId),
        ),
      )
      .limit(1)
  )[0];
  if (!row) return null;
  if (row.granular) return loadMemberScope(userId, teamId);
  if (!row.scoped || !row.roleId) return null;
  return loadRoleScope(row.roleId, teamId);
});

// The same rows that grant a person capabilities (ADR-0016), read as reach rather than power.
async function loadMemberScope(
  userId: string,
  teamId: string,
): Promise<NodeScope> {
  const db = getDb();
  const [projRows, folderRows, appRows] = await Promise.all([
    db
      .selectDistinct({ id: projectGrants.projectId })
      .from(projectGrants)
      .innerJoin(projectsTable, eq(projectsTable.id, projectGrants.projectId))
      .where(
        and(eq(projectGrants.userId, userId), eq(projectsTable.teamId, teamId)),
      ),
    db
      .selectDistinct({
        id: folderGrants.folderId,
        projectId: foldersTable.projectId,
      })
      .from(folderGrants)
      .innerJoin(foldersTable, eq(foldersTable.id, folderGrants.folderId))
      .where(
        and(eq(folderGrants.userId, userId), eq(foldersTable.teamId, teamId)),
      ),
    db
      .selectDistinct({ id: appGrants.appId, projectId: appsTable.projectId })
      .from(appGrants)
      .innerJoin(appsTable, eq(appsTable.id, appGrants.appId))
      .where(and(eq(appGrants.userId, userId), eq(appsTable.teamId, teamId))),
  ]);

  const projectIds = projRows.map((r) => r.id);
  const { folderIds, folderProjectIds } = await expandFolders(
    [teamId],
    folderRows.map((r) => r.id),
    projectIds,
  );
  return {
    projectIds,
    // No environment rung: a grant cannot name one, so this list is always empty here.
    environmentIds: [],
    folderIds,
    appIds: appRows.map((r) => r.id),
    appProjectIds: [
      ...new Set(
        [
          ...appRows.map((r) => r.projectId),
          ...folderRows.map((r) => r.projectId),
          ...folderProjectIds,
        ].filter((id): id is string => id != null),
      ),
    ],
  };
}

// loadRoleScope expands the junctions of one scoped role.
export async function loadRoleScope(
  roleId: string,
  teamId: string,
): Promise<NodeScope> {
  const db = getDb();
  const [projRows, envRows, folderRows, appRows] = await Promise.all([
    db
      .select({ id: teamRoleScopeProjects.projectId })
      .from(teamRoleScopeProjects)
      .where(eq(teamRoleScopeProjects.roleId, roleId)),
    db
      .select({
        id: teamRoleScopeEnvironments.environmentId,
        projectId: environmentsTable.projectId,
      })
      .from(teamRoleScopeEnvironments)
      .innerJoin(
        environmentsTable,
        eq(environmentsTable.id, teamRoleScopeEnvironments.environmentId),
      )
      .where(eq(teamRoleScopeEnvironments.roleId, roleId)),
    db
      .select({
        id: teamRoleScopeFolders.folderId,
        projectId: foldersTable.projectId,
      })
      .from(teamRoleScopeFolders)
      .innerJoin(
        foldersTable,
        eq(foldersTable.id, teamRoleScopeFolders.folderId),
      )
      .where(eq(teamRoleScopeFolders.roleId, roleId)),
    db
      .select({
        id: teamRoleScopeApps.appId,
        projectId: appsTable.projectId,
      })
      .from(teamRoleScopeApps)
      .innerJoin(appsTable, eq(appsTable.id, teamRoleScopeApps.appId))
      .where(eq(teamRoleScopeApps.roleId, roleId)),
  ]);

  const projectIds = projRows.map((r) => r.id);
  const { folderIds, folderProjectIds } = await expandFolders(
    [teamId],
    folderRows.map((r) => r.id),
    projectIds,
  );
  return {
    projectIds,
    environmentIds: envRows.map((r) => r.id),
    folderIds,
    appIds: appRows.map((r) => r.id),
    appProjectIds: [
      ...new Set(
        [
          // A named node makes its project navigable: no drilling into staging without its project.
          ...envRows.map((r) => r.projectId),
          ...appRows.map((r) => r.projectId),
          ...folderRows.map((r) => r.projectId),
          ...folderProjectIds,
        ].filter((id): id is string => id != null),
      ),
    ],
  };
}

// appInScope: an app lives in exactly ONE place - folder, project or team top level - so the clauses are alternatives.
export function appInScope(
  scope: NodeScope | null,
  app: {
    id: string;
    folderId?: string | null;
    projectId?: string | null;
    environmentId?: string | null;
  },
): boolean {
  if (!scope) return true;
  if (scope.appIds.includes(app.id)) return true;
  if (app.folderId != null && scope.folderIds.includes(app.folderId))
    return true;
  if (
    app.environmentId != null &&
    scope.environmentIds.includes(app.environmentId)
  )
    return true;
  return app.projectId != null && scope.projectIds.includes(app.projectId);
}

// environmentInScope is strict, like a folder: an environment is reached by being named.
export function environmentInScope(
  scope: NodeScope | null,
  environmentId: string | null,
): boolean {
  if (!scope) return true;
  return environmentId != null && scope.environmentIds.includes(environmentId);
}

// folderInScope is strict: the subtree is already flattened into folderIds, so no walk here.
export function folderInScope(
  scope: NodeScope | null,
  folderId: string | null,
): boolean {
  if (!scope) return true;
  return folderId != null && scope.folderIds.includes(folderId);
}

// projectInScope: a project is reached by being named, or by containing something that was.
export function projectInScope(
  scope: NodeScope | null,
  projectId: string | null,
): boolean {
  if (!scope) return true;
  if (projectId == null) return false;
  return (
    scope.projectIds.includes(projectId) ||
    scope.appProjectIds.includes(projectId)
  );
}
