import "server-only";

import { eq, inArray } from "drizzle-orm";

import { getDb } from "../../db/client";
import {
  appGrants as appGrantsTable,
  environmentGrants as environmentGrantsTable,
  folderGrants as folderGrantsTable,
  memberships as membershipsTable,
  membershipCapabilities as membershipCapabilitiesTable,
  projectGrants as projectGrantsTable,
  teamRoleCapabilities as teamRoleCapabilitiesTable,
  teamRoles as teamRolesTable,
} from "../../db/schema/control-plane/access-control";
import { users as usersTable } from "../../db/schema/control-plane/identity";
import { ALL_CAPABILITIES } from "../../types/identity";
import type {
  DeploExportAccess,
  DeploExportGrant,
} from "../../migration/deplo/export-shape";
import { loadRoleScopes } from "../roles/scope";

// Only nodes the export itself carries: a grant or a scope never names a private folder the reader cannot open.
export interface ExportedNodes {
  projectIds: Set<string>;
  environmentIds: Set<string>;
  folderIds: Set<string>;
  appIds: Set<string>;
}

const ordered = (caps: string[]): string[] =>
  ALL_CAPABILITIES.filter((c) => caps.includes(c));

function grouped(
  rows: { key: string; userId: string; capability: string }[],
): Map<string, Map<string, string[]>> {
  const out = new Map<string, Map<string, string[]>>();
  for (const r of rows) {
    const byNode = out.get(r.userId) ?? new Map<string, string[]>();
    byNode.set(r.key, [...(byNode.get(r.key) ?? []), r.capability]);
    out.set(r.userId, byNode);
  }
  return out;
}

export async function exportAccess(
  teamId: string,
  nodes: ExportedNodes,
): Promise<DeploExportAccess> {
  const db = getDb();
  const roles = await db
    .select()
    .from(teamRolesTable)
    .where(eq(teamRolesTable.teamId, teamId));
  const roleIds = roles.map((r) => r.id);
  const [roleCaps, scopes, members] = await Promise.all([
    roleIds.length
      ? db
          .select()
          .from(teamRoleCapabilitiesTable)
          .where(inArray(teamRoleCapabilitiesTable.roleId, roleIds))
      : [],
    loadRoleScopes(db, roleIds),
    db
      .select({ m: membershipsTable, email: usersTable.email })
      .from(membershipsTable)
      .innerJoin(usersTable, eq(usersTable.id, membershipsTable.userId))
      .where(eq(membershipsTable.teamId, teamId)),
  ]);
  const userIds = members.map((r) => r.m.userId);
  const memberIds = members.map((r) => r.m.id);
  const none = userIds.length === 0;
  const known =
    (ids: Set<string>) =>
    (rows: { key: string; userId: string; capability: string }[]) =>
      rows.filter((r) => ids.has(r.key));
  const [memberCaps, projectRows, environmentRows, folderRows, appRows] =
    await Promise.all([
      memberIds.length
        ? db
            .select()
            .from(membershipCapabilitiesTable)
            .where(inArray(membershipCapabilitiesTable.membershipId, memberIds))
        : [],
      none
        ? []
        : db
            .select({
              key: projectGrantsTable.projectId,
              userId: projectGrantsTable.userId,
              capability: projectGrantsTable.capability,
            })
            .from(projectGrantsTable)
            .where(inArray(projectGrantsTable.userId, userIds))
            .then(known(nodes.projectIds)),
      none
        ? []
        : db
            .select({
              key: environmentGrantsTable.environmentId,
              userId: environmentGrantsTable.userId,
              capability: environmentGrantsTable.capability,
            })
            .from(environmentGrantsTable)
            .where(inArray(environmentGrantsTable.userId, userIds))
            .then(known(nodes.environmentIds)),
      none
        ? []
        : db
            .select({
              key: folderGrantsTable.folderId,
              userId: folderGrantsTable.userId,
              capability: folderGrantsTable.capability,
            })
            .from(folderGrantsTable)
            .where(inArray(folderGrantsTable.userId, userIds))
            .then(known(nodes.folderIds)),
      none
        ? []
        : db
            .select({
              key: appGrantsTable.appId,
              userId: appGrantsTable.userId,
              capability: appGrantsTable.capability,
            })
            .from(appGrantsTable)
            .where(inArray(appGrantsTable.userId, userIds))
            .then(known(nodes.appIds)),
    ]);
  const grants: {
    kind: DeploExportGrant["kind"];
    byUser: Map<string, Map<string, string[]>>;
  }[] = [
    { kind: "project", byUser: grouped(projectRows) },
    { kind: "environment", byUser: grouped(environmentRows) },
    { kind: "folder", byUser: grouped(folderRows) },
    { kind: "app", byUser: grouped(appRows) },
  ];

  const keep = (ids: string[], known: Set<string>) =>
    ids.filter((id) => known.has(id));
  return {
    roles: roles.map((r) => {
      const s = scopes.get(r.id);
      return {
        id: r.id,
        name: r.name,
        description: r.description,
        builtinKey: r.builtinKey,
        capabilities: ordered(
          roleCaps.filter((c) => c.roleId === r.id).map((c) => c.capability),
        ),
        scoped: r.scoped,
        requireTwoFactor: r.requireTwoFactor,
        scope: r.scoped
          ? {
              projectIds: keep(s?.projectIds ?? [], nodes.projectIds),
              environmentIds: keep(
                s?.environmentIds ?? [],
                nodes.environmentIds,
              ),
              folderIds: keep(s?.folderIds ?? [], nodes.folderIds),
              appIds: keep(s?.appIds ?? [], nodes.appIds),
            }
          : null,
      };
    }),
    members: members.map(({ m, email }) => ({
      email,
      rank: m.role,
      roleId: m.roleId,
      granular: m.granular,
      customCapabilities: m.customCapabilities,
      capabilities: ordered(
        memberCaps
          .filter((c) => c.membershipId === m.id)
          .map((c) => c.capability),
      ),
      grants: grants.flatMap(({ kind, byUser }) =>
        [...(byUser.get(m.userId)?.entries() ?? [])].map(
          ([nodeId, caps]): DeploExportGrant => ({
            kind,
            nodeId,
            capabilities: ordered(caps),
          }),
        ),
      ),
    })),
  };
}
