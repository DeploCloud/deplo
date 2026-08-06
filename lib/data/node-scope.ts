import "server-only";

import { cache } from "react";
import { and, eq, inArray } from "drizzle-orm";

import { getDb } from "../db/client";
import {
  apps as appsTable,
  environments as environmentsTable,
  folders as foldersTable,
  memberships as membershipsTable,
  teamRoles as teamRolesTable,
  teamRoleScopeApps,
  teamRoleScopeEnvironments,
  teamRoleScopeFolders,
  teamRoleScopeProjects,
} from "../db/schema/control-plane";

/**
 * REACH, as opposed to POWER: which nodes of a team a principal can touch at
 * all, before anyone asks what they may do there.
 *
 * The two axes are already separate in this codebase — `lib/data/node-access.ts`
 * answers power through the grant ladder, and an API token has carried a reach
 * of its own since ADR-0015. This module is the same idea for a person: a team
 * ROLE may name whole projects, whole folders, or single apps, and its holders
 * reach nothing else.
 *
 * Deliberately free of `lib/membership.ts`, `lib/data/tokens.ts` and
 * `lib/data/node-access.ts`, all three of which need it: it is the leaf that
 * keeps the graph acyclic, and it is why {@link expandFolders} lives here rather
 * than in the token module it was written for.
 *
 * The predicates below mirror `inAppScope` / `inFolderScope` / `inProjectScope`
 * in `lib/auth/request-context.ts` clause for clause, because the two answers
 * compose as a CONJUNCTION: a token narrowed to one project, held by a member
 * whose role reaches one app inside it, reaches that app. Composing them as sets
 * would need a query to decide whether a named app sits inside a named project;
 * composing them as predicates needs nothing.
 */

/** What a scope names. `null` anywhere below means "unrestricted". */
export interface NodeScope {
  projectIds: string[];
  /**
   * Ticked environments. An app lives in exactly one (ADR-0009), so this is the
   * finest cut inside a project a scope can make. Filing an app into a folder
   * CLEARS its environment, which is why the app predicate asks the folder
   * first: the two are alternatives, never both.
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
 * Every folder a scope actually reaches: the ticked ones, everything nested
 * under them, and everything filed under a ticked project — plus the projects
 * those folders sit in, so the containers stay navigable.
 *
 * One query for the folder set of the teams involved, then a walk in memory:
 * folder trees are small (an Overview a person browses). Cycle-safe by the
 * seen-set, the same tolerance the rest of the folder-tree code applies to a
 * stale parent — a resolver that hangs is a worse outage than one that stops.
 */
export async function expandFolders(
  teamIds: string[],
  ticked: string[],
  scopedProjectIds: string[],
): Promise<{ folderIds: string[]; folderProjectIds: string[] }> {
  if (teamIds.length === 0 || (ticked.length === 0 && scopedProjectIds.length === 0))
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
    ...rows.filter((f) => f.projectId && projects.has(f.projectId)).map((f) => f.id),
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
 * The reach of the role this person holds in this team, or `null` when their
 * role is unrestricted — which is every role until someone limits one, and so
 * the answer for every instance today.
 *
 * `team_roles.scoped` is asked, not "are there any rows": the junctions CASCADE,
 * so deleting the last project a role named empties the scope, and reading that
 * as "unrestricted" would widen the role at the exact moment somebody deleted
 * something. Scoped with nothing left reaches nothing.
 *
 * A membership with no role (`role_id` NULL — the legacy hand-picked set) is
 * unrestricted: there is no role to carry a scope.
 */
export const roleScopeFor = cache(async function roleScopeFor(
  userId: string,
  teamId: string,
): Promise<NodeScope | null> {
  const db = getDb();
  const row = (
    await db
      .select({ roleId: teamRolesTable.id, scoped: teamRolesTable.scoped })
      .from(membershipsTable)
      .innerJoin(teamRolesTable, eq(teamRolesTable.id, membershipsTable.roleId))
      .where(
        and(
          eq(membershipsTable.userId, userId),
          eq(membershipsTable.teamId, teamId),
        ),
      )
      .limit(1)
  )[0];
  if (!row?.scoped) return null;
  return loadRoleScope(row.roleId, teamId);
});

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
      .innerJoin(foldersTable, eq(foldersTable.id, teamRoleScopeFolders.folderId))
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
          // A named node makes its project navigable, whatever kind it is: you
          // cannot drill into staging, or into one app, without seeing the
          // project that holds it. Leaving the APPS out of this list is what
          // showed a role scoped to single apps an empty Overview — the apps
          // resolved, and the container they live in did not.
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
 * alternatives. An app at the top level is in no container at all and is reached
 * only by naming it: fail-closed, and it stops a scope from widening the moment
 * someone drags an app out of a folder.
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
  if (app.folderId != null && scope.folderIds.includes(app.folderId)) return true;
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
    scope.projectIds.includes(projectId) || scope.appProjectIds.includes(projectId)
  );
}
