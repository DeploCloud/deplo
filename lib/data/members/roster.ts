import "server-only";

import { and, eq, inArray } from "drizzle-orm";
import { getDb, type DbTx } from "../../db/client";
import {
  appGrants as appGrantsTable,
  folderGrants as folderGrantsTable,
  memberships as membershipsTable,
  membershipCapabilities as membershipCapabilitiesTable,
  projectGrants as projectGrantsTable,
  teamRoles as teamRolesTable,
  teamRoleCapabilities as teamRoleCapabilitiesTable,
} from "../../db/schema/control-plane/access-control";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import {
  teams as teamsTable,
  users as usersTable,
} from "../../db/schema/control-plane/identity";
import {
  folders as foldersTable,
  projects as projectsTable,
} from "../../db/schema/control-plane/projects";
import { tokenCountsByUser } from "../tokens/reach";
import { avatarResolver } from "../../avatar";
import { requireActiveTeamId, requireTeamWide } from "../../membership";
import { accessDelta } from "../../membership-shared";
import { ensureTeamRoles } from "../roles/builtin-roles";
import { effectiveRoleCapabilities } from "../roles/member-capabilities";
import { loadRoleScopes } from "../roles/scope";
import type { Capability, Role } from "../../types/identity";

export interface MemberDTO {
  userId: string;
  membershipId: string;
  username: string;
  name: string;
  role: Role;
  roleId: string | null;
  roleName: string | null;
  roleScoped: boolean;
  capabilities: Capability[];
  accessDelta: "less" | "more" | null;
  tokenCount: number;
  agentCount: number;
  isPrimaryOwner: boolean;
  isInstanceAdmin: boolean;
  avatarColor: string;
  avatarUrl: string | null;
  createdAt: string;
}

async function capabilitiesByMembership(
  db: ReturnType<typeof getDb> | DbTx,
  membershipIds: string[],
): Promise<Map<string, Capability[]>> {
  const byId = new Map<string, Capability[]>();
  if (membershipIds.length === 0) return byId;
  const rows = await db
    .select({
      membershipId: membershipCapabilitiesTable.membershipId,
      capability: membershipCapabilitiesTable.capability,
    })
    .from(membershipCapabilitiesTable)
    .where(inArray(membershipCapabilitiesTable.membershipId, membershipIds));
  for (const r of rows) {
    const list = byId.get(r.membershipId) ?? [];
    list.push(r.capability as Capability);
    byId.set(r.membershipId, list);
  }
  return byId;
}

export async function listMembers(): Promise<MemberDTO[]> {
  await requireTeamWide("team members");
  const teamId = await requireActiveTeamId();
  const db = getDb();
  await ensureTeamRoles(db, teamId);
  const founderId = await teamFounderUserId(db, teamId);
  const rows = await db
    .select({
      membershipId: membershipsTable.id,
      role: membershipsTable.role,
      roleId: membershipsTable.roleId,
      roleName: teamRolesTable.name,
      roleScoped: teamRolesTable.scoped,
      granular: membershipsTable.granular,
      customCapabilities: membershipsTable.customCapabilities,
      createdAt: membershipsTable.createdAt,
      userId: usersTable.id,
      username: usersTable.username,
      name: usersTable.name,
      avatarColor: usersTable.avatarColor,
      image: usersTable.image,
      email: usersTable.email,
      isInstanceAdmin: usersTable.isInstanceAdmin,
    })
    .from(membershipsTable)
    .innerJoin(usersTable, eq(usersTable.id, membershipsTable.userId))
    .leftJoin(teamRolesTable, eq(teamRolesTable.id, membershipsTable.roleId))
    .where(eq(membershipsTable.teamId, teamId))
    .orderBy(membershipsTable.createdAt);
  const caps = await capabilitiesByMembership(
    db,
    rows.map((r) => r.membershipId),
  );
  const deltas = await memberDeltas(db, teamId, rows, caps);
  const tokens = await tokenCountsByUser(teamId);
  const avatarUrl = await avatarResolver();
  return rows.map((r) => ({
    userId: r.userId,
    membershipId: r.membershipId,
    username: r.username,
    name: r.name,
    role: r.role as Role,
    roleId: r.roleId ?? null,
    roleName: r.roleName ?? null,
    roleScoped: r.roleScoped ?? false,
    capabilities: caps.get(r.membershipId) ?? [],
    accessDelta: deltas.get(r.membershipId) ?? null,
    tokenCount: tokens.get(r.userId)?.tokens ?? 0,
    agentCount: tokens.get(r.userId)?.agents ?? 0,
    isPrimaryOwner: r.userId === founderId,
    isInstanceAdmin: r.isInstanceAdmin ?? false,
    avatarColor: r.avatarColor,
    avatarUrl: avatarUrl(r),
    createdAt: r.createdAt,
  }));
}

async function memberDeltas(
  db: ReturnType<typeof getDb>,
  teamId: string,
  rows: {
    membershipId: string;
    userId: string;
    roleId: string | null;
    roleScoped: boolean | null;
    granular: boolean;
    customCapabilities: boolean;
  }[],
  caps: Map<string, Capability[]>,
): Promise<Map<string, "less" | "more" | null>> {
  const out = new Map<string, "less" | "more" | null>();
  const nodes = await memberNodeIds(
    db,
    teamId,
    rows.map((r) => r.userId),
  );
  const personalised = rows.filter(
    (r) =>
      r.roleId != null &&
      (r.granular ||
        r.customCapabilities ||
        (nodes.get(r.userId) ?? []).length > 0),
  );
  if (personalised.length === 0) return out;

  const roleIds = [...new Set(personalised.map((r) => r.roleId!))];
  const roleCapRows = await db
    .select({
      roleId: teamRoleCapabilitiesTable.roleId,
      capability: teamRoleCapabilitiesTable.capability,
    })
    .from(teamRoleCapabilitiesTable)
    .where(inArray(teamRoleCapabilitiesTable.roleId, roleIds));
  const authored = new Map<string, Capability[]>();
  for (const r of roleCapRows)
    authored.set(r.roleId, [
      ...(authored.get(r.roleId) ?? []),
      r.capability as Capability,
    ]);
  const scopes = await loadRoleScopes(
    db,
    personalised.filter((r) => r.roleScoped).map((r) => r.roleId!),
  );

  for (const r of personalised) {
    const scope = r.roleScoped ? scopes.get(r.roleId!) : null;
    out.set(
      r.membershipId,
      accessDelta({
        capabilities: caps.get(r.membershipId) ?? [],
        roleCapabilities: effectiveRoleCapabilities(
          authored.get(r.roleId!) ?? [],
          r.roleScoped ?? false,
        ),
        granular: r.granular,
        nodeIds: nodes.get(r.userId) ?? [],
        roleNodeIds: scope
          ? [
              ...scope.projectIds,
              ...scope.environmentIds,
              ...scope.folderIds,
              ...scope.appIds,
            ]
          : r.roleScoped
            ? []
            : null,
      }),
    );
  }
  return out;
}

async function memberNodeIds(
  db: ReturnType<typeof getDb>,
  teamId: string,
  userIds: string[],
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (userIds.length === 0) return out;
  const [projects, folders, apps] = await Promise.all([
    db
      .selectDistinct({
        userId: projectGrantsTable.userId,
        id: projectGrantsTable.projectId,
      })
      .from(projectGrantsTable)
      .innerJoin(
        projectsTable,
        eq(projectsTable.id, projectGrantsTable.projectId),
      )
      .where(
        and(
          inArray(projectGrantsTable.userId, userIds),
          eq(projectsTable.teamId, teamId),
        ),
      ),
    db
      .selectDistinct({
        userId: folderGrantsTable.userId,
        id: folderGrantsTable.folderId,
      })
      .from(folderGrantsTable)
      .innerJoin(foldersTable, eq(foldersTable.id, folderGrantsTable.folderId))
      .where(
        and(
          inArray(folderGrantsTable.userId, userIds),
          eq(foldersTable.teamId, teamId),
        ),
      ),
    db
      .selectDistinct({
        userId: appGrantsTable.userId,
        id: appGrantsTable.appId,
      })
      .from(appGrantsTable)
      .innerJoin(appsTable, eq(appsTable.id, appGrantsTable.appId))
      .where(
        and(
          inArray(appGrantsTable.userId, userIds),
          eq(appsTable.teamId, teamId),
        ),
      ),
  ]);
  for (const r of [...projects, ...folders, ...apps])
    out.set(r.userId, [...(out.get(r.userId) ?? []), r.id]);
  return out;
}

export async function teamFounderUserId(
  db: ReturnType<typeof getDb> | DbTx,
  teamId: string,
): Promise<string | null> {
  const rows = await db
    .select({ founderUserId: teamsTable.founderUserId })
    .from(teamsTable)
    .where(eq(teamsTable.id, teamId))
    .limit(1);
  return rows[0]?.founderUserId ?? null;
}
