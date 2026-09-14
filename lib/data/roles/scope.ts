import "server-only";

import { and, eq, inArray } from "drizzle-orm";

import { getDb, type DbTx } from "../../db/client";
import {
  teamRoleScopeApps,
  teamRoleScopeEnvironments,
  teamRoleScopeFolders,
  teamRoleScopeProjects,
} from "../../db/schema/control-plane/access-control";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import {
  environments as environmentsTable,
  projects as projectsTable,
} from "../../db/schema/control-plane/projects";
import { appCapabilitiesForTeam, nodeCapabilitiesFor } from "../node-access";
import { memberScopeFor } from "../node-scope";
import { type Db } from "./role-guards";

// The four id lists a scope stores, resolved.
export type ResolvedScope = {
  projectIds: string[];
  environmentIds: string[];
  folderIds: string[];
  appIds: string[];
};

// A role that reaches nothing left - every node it named was deleted.
export const EMPTY_SCOPE: ResolvedScope = {
  projectIds: [],
  environmentIds: [],
  folderIds: [],
  appIds: [],
};

// The nodes a role is limited to, as the editor sends them.
export interface RoleScopeInput {
  projectIds?: string[];
  environmentIds?: string[];
  folderIds?: string[];
  appIds?: string[];
}

// loadRoleScopes - the scope junctions of several roles at once: three queries for a
// page, never one per role. Only the SCOPED ones need asking.
export async function loadRoleScopes(
  db: Db,
  roleIds: string[],
): Promise<Map<string, ResolvedScope>> {
  const out = new Map<string, ResolvedScope>();
  if (roleIds.length === 0) return out;
  const [projects, environments, folders, apps] = await Promise.all([
    db
      .select({
        roleId: teamRoleScopeProjects.roleId,
        id: teamRoleScopeProjects.projectId,
      })
      .from(teamRoleScopeProjects)
      .where(inArray(teamRoleScopeProjects.roleId, roleIds)),
    db
      .select({
        roleId: teamRoleScopeEnvironments.roleId,
        id: teamRoleScopeEnvironments.environmentId,
      })
      .from(teamRoleScopeEnvironments)
      .where(inArray(teamRoleScopeEnvironments.roleId, roleIds)),
    db
      .select({
        roleId: teamRoleScopeFolders.roleId,
        id: teamRoleScopeFolders.folderId,
      })
      .from(teamRoleScopeFolders)
      .where(inArray(teamRoleScopeFolders.roleId, roleIds)),
    db
      .select({ roleId: teamRoleScopeApps.roleId, id: teamRoleScopeApps.appId })
      .from(teamRoleScopeApps)
      .where(inArray(teamRoleScopeApps.roleId, roleIds)),
  ]);
  const at = (roleId: string) => {
    const cur = out.get(roleId) ?? {
      projectIds: [],
      environmentIds: [],
      folderIds: [],
      appIds: [],
    };
    out.set(roleId, cur);
    return cur;
  };
  for (const r of projects) at(r.roleId).projectIds.push(r.id);
  for (const r of environments) at(r.roleId).environmentIds.push(r.id);
  for (const r of folders) at(r.roleId).folderIds.push(r.id);
  for (const r of apps) at(r.roleId).appIds.push(r.id);
  return out;
}

// resolveRoleScope - validate a scope against the team and the ACTOR's own reach. A node
// the actor cannot reach answers as one that isn't in the team: a refusal must never
// confirm which private folders exist.
export async function resolveRoleScope(
  teamId: string,
  actingUserId: string,
  input: RoleScopeInput | null,
): Promise<ResolvedScope | null> {
  const actorScope = await memberScopeFor(actingUserId, teamId);
  if (input === null) {
    if (actorScope)
      throw new Error(
        "Your own role reaches part of this team, so you can't give a role the whole of it.",
      );
    return null;
  }
  const out: ResolvedScope = {
    projectIds: [...new Set(input.projectIds ?? [])],
    environmentIds: [...new Set(input.environmentIds ?? [])],
    folderIds: [...new Set(input.folderIds ?? [])],
    appIds: [...new Set(input.appIds ?? [])],
  };
  if (out.appIds.length > 0) {
    const rows = await getDb()
      .select({
        id: appsTable.id,
        folderId: appsTable.folderId,
        projectId: appsTable.projectId,
        environmentId: appsTable.environmentId,
      })
      .from(appsTable)
      .where(
        and(inArray(appsTable.id, out.appIds), eq(appsTable.teamId, teamId)),
      );
    if (rows.length !== out.appIds.length)
      throw new Error("One of those isn't in this team any more");
    const reach = await appCapabilitiesForTeam(
      teamId,
      rows.map((a) => ({
        id: a.id,
        folderId: a.folderId ?? null,
        projectId: a.projectId ?? null,
        environmentId: a.environmentId ?? null,
      })),
    );
    for (const id of out.appIds)
      if ((reach.get(id) ?? []).length === 0)
        throw new Error("One of those isn't in this team any more");
  }
  for (const [kind, ids] of [
    ["project", out.projectIds],
    ["folder", out.folderIds],
  ] as const) {
    for (const id of ids) {
      const mine = await nodeCapabilitiesFor(actingUserId, teamId, {
        kind,
        id,
      });
      if (mine.length === 0)
        throw new Error("One of those isn't in this team any more");
    }
  }
  // An environment is checked through its PROJECT: it is not a node of the grant
  // ladder in its own right, and reaching the project reaches the environments in it.
  if (out.environmentIds.length > 0) {
    const envs = await getDb()
      .select({
        id: environmentsTable.id,
        projectId: environmentsTable.projectId,
        teamId: projectsTable.teamId,
      })
      .from(environmentsTable)
      .innerJoin(
        projectsTable,
        eq(projectsTable.id, environmentsTable.projectId),
      )
      .where(inArray(environmentsTable.id, out.environmentIds));
    if (envs.length !== out.environmentIds.length)
      throw new Error("One of those isn't in this team any more");
    for (const e of envs) {
      if (e.teamId !== teamId)
        throw new Error("One of those isn't in this team any more");
      const mine = await nodeCapabilitiesFor(actingUserId, teamId, {
        kind: "project",
        id: e.projectId,
      });
      if (mine.length === 0)
        throw new Error("One of those isn't in this team any more");
    }
  }
  return out;
}

// writeRoleScope - whole-set replace of a role's scope junctions.
export async function writeRoleScope(
  tx: DbTx,
  roleId: string,
  scope: ResolvedScope | null,
): Promise<void> {
  await tx
    .delete(teamRoleScopeProjects)
    .where(eq(teamRoleScopeProjects.roleId, roleId));
  await tx
    .delete(teamRoleScopeEnvironments)
    .where(eq(teamRoleScopeEnvironments.roleId, roleId));
  await tx
    .delete(teamRoleScopeFolders)
    .where(eq(teamRoleScopeFolders.roleId, roleId));
  await tx
    .delete(teamRoleScopeApps)
    .where(eq(teamRoleScopeApps.roleId, roleId));
  if (!scope) return;
  if (scope.projectIds.length)
    await tx
      .insert(teamRoleScopeProjects)
      .values(scope.projectIds.map((projectId) => ({ roleId, projectId })));
  if (scope.environmentIds.length)
    await tx.insert(teamRoleScopeEnvironments).values(
      scope.environmentIds.map((environmentId) => ({
        roleId,
        environmentId,
      })),
    );
  if (scope.folderIds.length)
    await tx
      .insert(teamRoleScopeFolders)
      .values(scope.folderIds.map((folderId) => ({ roleId, folderId })));
  if (scope.appIds.length)
    await tx
      .insert(teamRoleScopeApps)
      .values(scope.appIds.map((appId) => ({ roleId, appId })));
}
