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

// What a member assignment resolves to: the rank on the membership row, its role
// (null ⇒ a hand-picked "Custom" set), and the effective capabilities to write.
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
  // A caller can only hand out capabilities they hold THEMSELVES - bounding the
  // assignment to the actor's own caps (same clamp as folder grants) closes the
  // escalation where a plain `manage_members` holder mints a member with capabilities
  const caps = withView(boundedBy(raw, actor.capabilities));
  const matched = await matchTeamRole(db, teamId, input.role, caps);
  return {
    rank: input.role,
    roleId: matched?.id ?? null,
    roleName: matched?.name ?? null,
    capabilities: caps,
  };
}

/** Add an already-registered user to the active team with a role. */
export async function addExistingMember(input: {
  userId: string;
  /** The team role to assign (Settings → Team → Roles). */
  roleId?: string;
  /** Legacy: rank + hand-picked capabilities. Ignored when `roleId` is given. */
  role?: Role;
  capabilities?: Capability[];
}): Promise<MemberDTO> {
  const { membership } = await requireCapability("manage_members");
  const teamId = membership.teamId;
  const db = getDb();
  await ensureTeamRoles(db, teamId);
  const assignment = await resolveAssignment(db, teamId, input, membership);
  // Granting the `owner` role is escalation - only an existing owner may add
  // another owner, so a plain `manage_members` holder cannot mint one above them.
  if (assignment.rank === "owner" && membership.role !== "owner")
    throw new Error("Only an owner can add another owner");
  const caps = assignment.capabilities;
  const targetRows = await db
    .select({
      id: usersTable.id,
      username: usersTable.username,
      name: usersTable.name,
      avatarColor: usersTable.avatarColor,
      // Consumed by `avatarUrl` on the returned DTO and dropped.
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
    // The UNIQUE(user_id, team_id) index closes the double-add race; on conflict
    // the insert no-ops and we leave the existing membership untouched.
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
    // A member is only ever ADDED on an existing role, and the card re-reads from
    // `listMembers` on the next render, so these need not be guessed at here.
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

// Administrative capabilities a team must never be left with zero holders of, or it
// locks itself out of member/team management irrecoverably.
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

/** Assert the team keeps a holder of each critical capability, under a `FOR UPDATE` lock. */
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

/** Assign a member's role (or, on the legacy path, their capability set). */
export async function updateMember(input: {
  userId: string;
  /** The team role to assign (Settings → Team → Roles). */
  roleId?: string;
  /** Legacy: rank + hand-picked capabilities. Ignored when `roleId` is given. */
  role?: Role;
  capabilities?: Capability[];
}): Promise<void> {
  const {
    teamId,
    userId: actingUserId,
    membership,
  } = await requireCapability("manage_members");
  const actorIsOwner = membership.role === "owner";
  // A non-owner can't edit their OWN membership (mirrors removeMember): the only
  // self-edit that would matter to them is an escalation.
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
    // A reach of named nodes holds nothing team-wide (the clamp `setMemberAccess`
    // applies); assigning a role here must not hand it back.
    const caps = m.granular
      ? boundedBy(assignment.capabilities, NODE_GRANTABLE_CAPABILITIES)
      : assignment.capabilities;
    // The ABSOLUTE owner (founder / "crown") is immutable: their role and
    // permissions can't be changed by anyone, including themselves and instance
    // admins, so the creator can never be locked out of their team.
    if (input.userId === founderId) {
      throw new Error(
        "The team's primary owner's role and permissions can't be changed.",
      );
    }
    // An (assigned) owner outranks non-owners: only another owner may change an
    // owner's permissions.
    if (m.role === "owner" && !actorIsOwner) {
      throw new Error("Only an owner can change another owner's permissions.");
    }
    // Promoting someone to the `owner` role is escalation - only an owner may do it.
    if (assignment.rank === "owner" && !actorIsOwner) {
      throw new Error("Only an owner can grant the owner role.");
    }
    await assertAdminCoverage(tx, teamId, input.userId, caps);
    // Assigning a role IS choosing to follow it: a set an admin had made this
    // member's own would otherwise keep the next role edit from reaching them.
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
  // Outside the transaction, per the recordActivity rule (own connection).
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

// The name to put in the trail for a user id, or a neutral stand-in.
async function usernameOf(userId: string): Promise<string> {
  const rows = await getDb()
    .select({ username: usersTable.username })
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);
  return rows[0]?.username ?? "a member";
}
