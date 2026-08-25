import "server-only";

import { cache } from "react";
import { and, eq, inArray } from "drizzle-orm";

import { getDb } from "../db/client";
import {
  appGrants,
  apps as appsTable,
  environments as environmentsTable,
  folderGrants,
  folders as foldersTable,
  memberships as membershipsTable,
  projectGrants,
  projects as projectsTable,
  teamRoles as teamRolesTable,
  teamRoleScopeApps,
  teamRoleScopeEnvironments,
  teamRoleScopeFolders,
  teamRoleScopeProjects,
} from "../db/schema/control-plane";

/**
 * REACH, as opposed to POWER: which nodes of a team a principal can touch at all,
 * before anyone asks what they may do there.
 */

/** What a scope names. `null` anywhere below means "unrestricted". */
export interface NodeScope {
  projectIds: string[];
  /**
   * Ticked environments. Filing an app into a folder CLEARS its environment, which
   * is why the app predicate asks the folder first: the two are alternatives,
   * never both.
   */
  environmentIds: string[];
  /** Ticked folders and their whole subtrees, expanded once at read time. */
  folderIds: string[];
  appIds: string[];
  /**
   * Projects that CONTAIN an individually named node, so the container stays
   * navigable without being granted. The token scope carries the same field for
   * the same reason.
   */
  appProjectIds: string[];
}

/**
 * Every folder a scope actually reaches: the ticked ones, everything nested under
 * them, and everything filed under a ticked project — plus the projects those
 * folders sit in, so the containers stay navigable.
 */
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

  // Roots: the ticked folders, plus every folder filed DIRECTLY under a ticked
  // project (their own subtrees follow below).
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

/**
 * The reach of this PERSON in this team, or `null` for the whole of it — which is
 * every member until someone limits one, and so the answer for most of them. Two
 * sources, in this order: 1. **their role's scope** otherwise.
 */
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
      // LEFT, not inner: a granular membership carries its own reach whether or
      // not it points at a role, and an inner join answered "unrestricted" for
      // the hand-picked ones.
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

/**
 * The nodes one person holds in a team, as a scope: the same rows that grant them
 * capabilities there (ADR-0016) read as REACH rather than as power.
 */
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
    // No environment rung: a grant cannot name one, so the member page never
    // offers it and this list is always empty here.
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

/** The junctions of one scoped role, expanded. Split out so tests can drive it. */
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
          // A named node makes its project navigable, whatever kind it is: you cannot drill
          // into staging, or into one app, without seeing the project that holds it.
          ...envRows.map((r) => r.projectId),
          ...appRows.map((r) => r.projectId),
          ...folderRows.map((r) => r.projectId),
          ...folderProjectIds,
        ].filter((id): id is string => id != null),
      ),
    ],
  };
}

/* ------------------------------------------------------------------ */
/* The predicates. Pure, and null means unrestricted.                  */
/* ------------------------------------------------------------------ */

/**
 * An app lives in exactly ONE place — a folder, a project, or the team top level
 * (filing it into a folder clears its project link) — so the three clauses are
 * alternatives.
 */
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

/** Strict, like a folder: an environment is reached by being named. */
export function environmentInScope(
  scope: NodeScope | null,
  environmentId: string | null,
): boolean {
  if (!scope) return true;
  return environmentId != null && scope.environmentIds.includes(environmentId);
}

/** Strict: the subtree is already flattened into `folderIds`, so no walk here. */
export function folderInScope(
  scope: NodeScope | null,
  folderId: string | null,
): boolean {
  if (!scope) return true;
  return folderId != null && scope.folderIds.includes(folderId);
}

/** A project is reached by being named, or by containing something that was. */
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
