import "server-only";

// https://deplo.build/docs/guides/team/members

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

/** A team member projected for the client (no password hash, no email). */
export interface MemberDTO {
  userId: string;
  membershipId: string;
  username: string;
  name: string;
  /** The member's RANK - 'owner' outranks everyone; for what to SHOW use {@link roleName}. */
  role: Role;
  /** The assigned team role, or null for a hand-picked ("Custom") set. */
  roleId: string | null;
  /** The assigned role's name, or null when the member holds a custom set. */
  roleName: string | null;
  /** Their role reaches only part of the team. */
  roleScoped: boolean;
  capabilities: Capability[];
  /** How their access compares with the role they hold, `null` when they are exactly it. */
  accessDelta: "less" | "more" | null;
  /** Counts only: a token is its owner's, and this is all a team gets to know about it. */
  tokenCount: number;
  agentCount: number;
  /** True for the team's ABSOLUTE owner - the founder who created the team (the "crown"). */
  isPrimaryOwner: boolean;
  isInstanceAdmin: boolean;
  avatarColor: string;
  /** Resolved picture: uploaded image, else Gravatar, else null for the monogram. */
  avatarUrl: string | null;
  createdAt: string;
}

// Batch-load each membership's capabilities from the junction in ONE query. Returns membershipId → caps.
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

/** Members of the active team. Email is never projected to the client. */
export async function listMembers(): Promise<MemberDTO[]> {
  await requireTeamWide("team members");
  const teamId = await requireActiveTeamId();
  const db = getDb();
  // Self-healing: a team that predates roles gets its three defaults here, so the
  // list names a real role instead of "Custom" for everyone.
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
      // Selected, never projected: both are consumed by `avatarUrl` below and
      // dropped. This DTO's contract is "no email", and it still holds.
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

// Each member's access measured against the role they hold, for the chip on their tile.
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
  // A membership with no role has nothing to differ FROM: it is the legacy
  // hand-picked set, which the roster already names "Custom".
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

// The nodes these people hold grants on inside one team, by user.
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

/** The user id of a team's founder (absolute owner / "crown"), or null. */
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
