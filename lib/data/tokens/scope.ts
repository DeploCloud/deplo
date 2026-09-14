import "server-only";

import { eq, inArray } from "drizzle-orm";

import { getDb, type DbTx } from "../../db/client";
import {
  apiTokenTeams,
  apiTokenProjects,
  apiTokenFolders,
  apiTokenApps,
} from "../../db/schema/control-plane/api-tokens";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import { teams as teamsTable } from "../../db/schema/control-plane/identity";
import {
  folders as foldersTable,
  projects as projectsTable,
} from "../../db/schema/control-plane/projects";
import { requireInstanceAdmin } from "../../membership";
// Lives in the leaf module so the ROLE scope that reuses this shape and this
// side never have to import each other (`node-scope.ts` explains why).
import { expandFolders } from "../node-scope";
import { cache } from "../../request-cache";
import { currentIdentity, type TokenScope } from "../../auth/request-context";
import { tokenReach } from "./reach";

export interface TokenScopeInput {
  /** Whole teams. */
  teamIds?: string[];
  /** Whole projects. */
  projectIds?: string[];
  /** Whole folders (their subtrees come with them). */
  folderIds?: string[];
  /** Individual apps. */
  appIds?: string[];
}

// ResolvedScope - the ticked-node lists, validated and de-duplicated.
export interface ResolvedScope {
  teamIds: string[];
  projectIds: string[];
  folderIds: string[];
  appIds: string[];
  // Every team the ticked nodes put in reach - the whole teams plus the owning
  // team of each project, folder and app.
  teamsReached: string[];
}

// validateScope - decide the two orthogonal switches, refusing the combination
// that cannot mean what it says: instance-admin gates read the user's admin flag
// and nothing else, so a scope could not narrow one.
export async function validateScope(
  input: { instanceAdmin?: boolean } & TokenScopeInput,
): Promise<{ scoped: boolean; instanceAdmin: boolean }> {
  const scoped =
    (input.teamIds?.length ?? 0) +
      (input.projectIds?.length ?? 0) +
      (input.folderIds?.length ?? 0) +
      (input.appIds?.length ?? 0) >
    0;
  const instanceAdmin = input.instanceAdmin ?? false;
  if (instanceAdmin && scoped)
    throw new Error(
      "A token limited to teams, projects or apps can't administer the instance. Pick one.",
    );
  // Only an instance admin can hand out instance administration.
  if (instanceAdmin) await requireInstanceAdmin();
  return { scoped, instanceAdmin };
}

// resolveScopeInput - validate every ticked node against what the ACTOR can reach.
export async function resolveScopeInput(
  input: TokenScopeInput,
  userId: string,
): Promise<ResolvedScope> {
  const teamIds = [...new Set(input.teamIds ?? [])];
  const projectIds = [...new Set(input.projectIds ?? [])];
  const folderIds = [...new Set(input.folderIds ?? [])];
  const appIds = [...new Set(input.appIds ?? [])];
  if (
    teamIds.length + projectIds.length + folderIds.length + appIds.length ===
    0
  )
    return {
      teamIds: [],
      projectIds: [],
      folderIds: [],
      appIds: [],
      teamsReached: [],
    };

  const mine = new Set((await tokenReach(userId)).map((t) => t.id));
  for (const id of teamIds)
    if (!mine.has(id))
      throw new Error("You can't use API tokens in one of those teams");
  // A SCOPED token minting (or re-authoring) one: every ticked node has to sit
  // INSIDE its own scope. Breadth alone is not enough - a token holding one project
  // of a team reaches that team, and could otherwise tick the whole of it.
  const acting = currentIdentity()?.token?.scope;
  const withinActing = (ok: boolean) => {
    if (acting && !ok)
      throw new Error(
        "This API token can't create a token that reaches outside its own scope.",
      );
  };
  for (const id of teamIds)
    withinActing(!acting || acting.wholeTeamIds.includes(id));
  const reached = new Set<string>(teamIds);
  // Refused rather than reinterpreted: `loadScope` lets the narrower tick win, so
  // accepting both would hand back a token that reads as whole-team and behaves
  // as one app. Say which one they meant.
  const whole = new Set(teamIds);
  const narrower = (teamId: string) => {
    if (whole.has(teamId))
      throw new Error(
        "Tick either the whole team or the parts of it, not both - the parts would win.",
      );
  };

  const db = getDb();
  if (projectIds.length > 0) {
    const rows = await db
      .select({ id: projectsTable.id, teamId: projectsTable.teamId })
      .from(projectsTable)
      .where(inArray(projectsTable.id, projectIds));
    if (
      rows.length !== projectIds.length ||
      rows.some((r) => !mine.has(r.teamId))
    )
      throw new Error(
        "One of those projects isn't in a team you can use API tokens in",
      );
    for (const r of rows) {
      narrower(r.teamId);
      reached.add(r.teamId);
      withinActing(
        !acting ||
          acting.wholeTeamIds.includes(r.teamId) ||
          acting.projectIds.includes(r.id),
      );
    }
  }
  if (folderIds.length > 0) {
    const rows = await db
      .select({ id: foldersTable.id, teamId: foldersTable.teamId })
      .from(foldersTable)
      .where(inArray(foldersTable.id, folderIds));
    if (
      rows.length !== folderIds.length ||
      rows.some((r) => !mine.has(r.teamId))
    )
      throw new Error(
        "One of those folders isn't in a team you can use API tokens in",
      );
    for (const r of rows) {
      narrower(r.teamId);
      reached.add(r.teamId);
      // The acting scope's folders are already the expanded subtree.
      withinActing(
        !acting ||
          acting.wholeTeamIds.includes(r.teamId) ||
          acting.folderIds.includes(r.id),
      );
    }
  }
  if (appIds.length > 0) {
    const rows = await db
      .select({
        id: appsTable.id,
        teamId: appsTable.teamId,
        folderId: appsTable.folderId,
        projectId: appsTable.projectId,
      })
      .from(appsTable)
      .where(inArray(appsTable.id, appIds));
    if (rows.length !== appIds.length || rows.some((r) => !mine.has(r.teamId)))
      throw new Error(
        "One of those apps isn't in a team you can use API tokens in",
      );
    for (const r of rows) {
      narrower(r.teamId);
      reached.add(r.teamId);
      withinActing(
        !acting ||
          acting.wholeTeamIds.includes(r.teamId) ||
          acting.appIds.includes(r.id) ||
          (r.folderId != null && acting.folderIds.includes(r.folderId)) ||
          (r.projectId != null && acting.projectIds.includes(r.projectId)),
      );
    }
  }
  return { teamIds, projectIds, folderIds, appIds, teamsReached: [...reached] };
}

// writeScope - persist the ticked nodes of a token, one junction per list.
export async function writeScope(
  tx: DbTx,
  tokenId: string,
  scope: ResolvedScope,
): Promise<void> {
  if (scope.teamIds.length > 0)
    await tx
      .insert(apiTokenTeams)
      .values(scope.teamIds.map((teamId) => ({ tokenId, teamId })));
  if (scope.projectIds.length > 0)
    await tx
      .insert(apiTokenProjects)
      .values(scope.projectIds.map((projectId) => ({ tokenId, projectId })));
  if (scope.folderIds.length > 0)
    await tx
      .insert(apiTokenFolders)
      .values(scope.folderIds.map((folderId) => ({ tokenId, folderId })));
  if (scope.appIds.length > 0)
    await tx
      .insert(apiTokenApps)
      .values(scope.appIds.map((appId) => ({ tokenId, appId })));
}

// loadScope - flatten a stored scope for the request identity.
export const loadScope = cache(async function loadScope(
  tokenId: string,
): Promise<TokenScope> {
  const db = getDb();
  const [teamRows, projRows, folderRows, appRows] = await Promise.all([
    db
      .select({ teamId: apiTokenTeams.teamId })
      .from(apiTokenTeams)
      .innerJoin(teamsTable, eq(teamsTable.id, apiTokenTeams.teamId))
      .where(eq(apiTokenTeams.tokenId, tokenId)),
    db
      .select({ id: projectsTable.id, teamId: projectsTable.teamId })
      .from(apiTokenProjects)
      .innerJoin(
        projectsTable,
        eq(projectsTable.id, apiTokenProjects.projectId),
      )
      .where(eq(apiTokenProjects.tokenId, tokenId)),
    db
      .select({
        id: foldersTable.id,
        teamId: foldersTable.teamId,
        projectId: foldersTable.projectId,
      })
      .from(apiTokenFolders)
      .innerJoin(foldersTable, eq(foldersTable.id, apiTokenFolders.folderId))
      .where(eq(apiTokenFolders.tokenId, tokenId)),
    db
      .select({
        id: appsTable.id,
        teamId: appsTable.teamId,
        projectId: appsTable.projectId,
        folderId: appsTable.folderId,
      })
      .from(apiTokenApps)
      .innerJoin(appsTable, eq(appsTable.id, apiTokenApps.appId))
      .where(eq(apiTokenApps.tokenId, tokenId)),
  ]);

  const projectIds = projRows.map((r) => r.id);
  // A team is WHOLE only when nothing narrower inside it is named.
  const narrowedTeamIds = new Set(
    [...projRows, ...folderRows, ...appRows].map((r) => r.teamId),
  );
  const wholeTeamIds = teamRows
    .map((r) => r.teamId)
    .filter((id) => !narrowedTeamIds.has(id));
  const teamIds = [
    ...new Set([
      ...teamRows.map((r) => r.teamId),
      ...projRows.map((r) => r.teamId),
      ...folderRows.map((r) => r.teamId),
      ...appRows.map((r) => r.teamId),
    ]),
  ];

  const { folderIds, folderProjectIds } = await expandFolders(
    teamIds,
    folderRows.map((r) => r.id),
    projectIds,
  );

  return {
    teamIds,
    wholeTeamIds,
    projectIds,
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
});
