import "server-only";

import { and, eq } from "drizzle-orm";
import { getDb, type DbTx } from "../../db/client";
import {
  memberships as membershipsTable,
  membershipCapabilities as membershipCapabilitiesTable,
} from "../../db/schema/control-plane/access-control";
import { users as usersTable } from "../../db/schema/control-plane/identity";
import { newId, nowIso } from "../../ids";
import { avatarUrlFor } from "../../avatar";
import { membershipFor, requireCapability } from "../../membership";
import {
  NODE_GRANTABLE_CAPABILITIES,
  cleanCapabilities,
} from "../../membership-shared";
import { ensureTeamRoles } from "../roles/builtin-roles";
import { matchTeamRole, roleAssignment } from "../roles/role-assignment";
import { boundedBy, withView } from "../folder-access";
import { recordActivity } from "../activity";
import { actorName } from "./activity-actor";
import { teamFounderUserId, type MemberDTO } from "./roster";
import type { Capability, Role } from "../../types/identity";

interface ResolvedAssignment {
  rank: Role;
  roleId: string | null;
  roleName: string | null;
  capabilities: Capability[];
}

async function resolveAssignment(
  db: ReturnType<typeof getDb> | DbTx,
  teamId: string,
  input: { roleId?: string; role?: Role; capabilities?: Capability[] },
  actor: { role: Role; capabilities: Capability[] },
): Promise<ResolvedAssignment> {
  if (input.roleId) {
    const a = await roleAssignment(db, teamId, input.roleId);
    const beyond = a.capabilities.filter(
      (c) => !actor.capabilities.includes(c),
    );
    if (beyond.length > 0)
      throw new Error(
        `You can only assign a role whose permissions you hold yourself - ${a.name} grants more than you do`,
      );
    return {
      rank: a.rank,
      roleId: a.roleId,
      roleName: a.name,
      capabilities: a.capabilities,
    };
  }
  if (!input.role) throw new Error("Choose a role for this member");
  const raw = cleanCapabilities(input.capabilities, input.role);
  const caps = withView(boundedBy(raw, actor.capabilities));
  const matched = await matchTeamRole(db, teamId, input.role, caps);
  return {
    rank: input.role,
    roleId: matched?.id ?? null,
    roleName: matched?.name ?? null,
    capabilities: caps,
  };
}

export async function addExistingMember(input: {
  userId: string;
  roleId?: string;
  role?: Role;
  capabilities?: Capability[];
}): Promise<MemberDTO> {
  const { membership } = await requireCapability("manage_members");
  const teamId = membership.teamId;
  const db = getDb();
  await ensureTeamRoles(db, teamId);
  const assignment = await resolveAssignment(db, teamId, input, membership);
  if (assignment.rank === "owner" && membership.role !== "owner")
    throw new Error("Only an owner can add another owner");
  const caps = assignment.capabilities;
  const targetRows = await db
    .select({
      id: usersTable.id,
      username: usersTable.username,
      name: usersTable.name,
      avatarColor: usersTable.avatarColor,
      image: usersTable.image,
      email: usersTable.email,
      isInstanceAdmin: usersTable.isInstanceAdmin,
    })
    .from(usersTable)
    .where(eq(usersTable.id, input.userId))
    .limit(1);
  const target = targetRows[0];
  if (!target) throw new Error("User not found");
  if (await membershipFor(target.id, teamId))
    throw new Error("That user is already a member of this team");

  const now = nowIso();
  const membershipId = newId("mbr");
  await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(membershipsTable)
      .values({
        id: membershipId,
        userId: target.id,
        teamId,
        role: assignment.rank,
        roleId: assignment.roleId,
        createdAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: membershipsTable.id });
    if (inserted.length > 0) {
      await tx
        .insert(membershipCapabilitiesTable)
        .values(caps.map((c) => ({ membershipId, capability: c })));
    }
  });
  await recordActivity(
    "member",
    `Added ${target.username} to the team`,
    await actorName(),
    null,
    teamId,
    "member_joined",
  );
  return {
    userId: target.id,
    membershipId,
    username: target.username,
    name: target.name,
    avatarUrl: await avatarUrlFor(target),
    role: assignment.rank,
    roleId: assignment.roleId,
    roleName: assignment.roleName,
    roleScoped: false,
    capabilities: caps,
    accessDelta: null,
    tokenCount: 0,
    agentCount: 0,
    isPrimaryOwner: false,
    isInstanceAdmin: target.isInstanceAdmin ?? false,
    avatarColor: target.avatarColor,
    createdAt: now,
  };
}

const CRITICAL_CAPABILITIES: Capability[] = [
  "manage_members",
  "manage_roles",
  "manage_team",
];
const CRITICAL_LABEL: Record<string, string> = {
  manage_members: "manage members",
  manage_roles: "manage roles",
  manage_team: "manage the team",
};

export async function assertAdminCoverage(
  tx: DbTx,
  teamId: string,
  targetUserId: string,
  nextCaps: Capability[] | null,
): Promise<void> {
  for (const cap of CRITICAL_CAPABILITIES) {
    const holders = await tx
      .select({ userId: membershipsTable.userId })
      .from(membershipsTable)
      .innerJoin(
        membershipCapabilitiesTable,
        eq(membershipCapabilitiesTable.membershipId, membershipsTable.id),
      )
      .where(
        and(
          eq(membershipsTable.teamId, teamId),
          eq(membershipCapabilitiesTable.capability, cap),
        ),
      )
      .for("update");
    const targetStillHolds = nextCaps !== null && nextCaps.includes(cap);
    const others = holders.filter((h) => h.userId !== targetUserId);
    if (others.length === 0 && !targetStillHolds) {
      throw new Error(
        `The team must keep at least one member who can ${CRITICAL_LABEL[cap]}`,
      );
    }
  }
}

export async function updateMember(input: {
  userId: string;
  roleId?: string;
  role?: Role;
  capabilities?: Capability[];
}): Promise<void> {
  const {
    teamId,
    userId: actingUserId,
    membership,
  } = await requireCapability("manage_members");
  const actorIsOwner = membership.role === "owner";
  if (input.userId === actingUserId && !actorIsOwner)
    throw new Error("You can't change your own role or permissions");
  const db = getDb();
  await ensureTeamRoles(db, teamId);
  const assignment = await resolveAssignment(db, teamId, input, membership);
  await db.transaction(async (tx) => {
    const founderId = await teamFounderUserId(tx, teamId);
    const rows = await tx
      .select({
        id: membershipsTable.id,
        role: membershipsTable.role,
        granular: membershipsTable.granular,
      })
      .from(membershipsTable)
      .where(
        and(
          eq(membershipsTable.userId, input.userId),
          eq(membershipsTable.teamId, teamId),
        ),
      )
      .limit(1);
    const m = rows[0];
    if (!m) throw new Error("Member not found");
    const caps = m.granular
      ? boundedBy(assignment.capabilities, NODE_GRANTABLE_CAPABILITIES)
      : assignment.capabilities;
    if (input.userId === founderId) {
      throw new Error(
        "The team's primary owner's role and permissions can't be changed.",
      );
    }
    if (m.role === "owner" && !actorIsOwner) {
      throw new Error("Only an owner can change another owner's permissions.");
    }
    if (assignment.rank === "owner" && !actorIsOwner) {
      throw new Error("Only an owner can grant the owner role.");
    }
    await assertAdminCoverage(tx, teamId, input.userId, caps);
    await tx
      .update(membershipsTable)
      .set({
        role: assignment.rank,
        roleId: assignment.roleId,
        customCapabilities: false,
      })
      .where(eq(membershipsTable.id, m.id));
    await tx
      .delete(membershipCapabilitiesTable)
      .where(eq(membershipCapabilitiesTable.membershipId, m.id));
    await tx
      .insert(membershipCapabilitiesTable)
      .values(caps.map((c) => ({ membershipId: m.id, capability: c })));
  });
  await recordActivity(
    "member",
    `Set @${await usernameOf(input.userId)}'s access to ${
      assignment.roleName
        ? `the ${assignment.roleName} role`
        : "their own set of permissions"
    }`,
    await actorName(),
    null,
    teamId,
    "member_access_changed",
  );
}

async function usernameOf(userId: string): Promise<string> {
  const rows = await getDb()
    .select({ username: usersTable.username })
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);
  return rows[0]?.username ?? "a member";
}
