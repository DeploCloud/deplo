import "server-only";

import { headers } from "next/headers";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  inArray,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import { getDb, type DbTx } from "../db/client";
import {
  memberships as membershipsTable,
  membershipCapabilities as membershipCapabilitiesTable,
  registrationLinks as registrationLinksTable,
  registrationLinkTeams as registrationLinkTeamsTable,
  registrationLinkTeamCapabilities as registrationLinkTeamCapabilitiesTable,
  teams as teamsTable,
  users as usersTable,
} from "../db/schema/control-plane";
import { newId, nowIso } from "../ids";
import { sha256Hex, randomToken, hashPassword } from "../crypto";
import { getCurrentUser } from "../auth";
import { recordActivity, listActivityByActor } from "./activity";
import { instanceOwnerUserId } from "./instance-owner";
import {
  requireCapability,
  requireActiveTeamId,
  requireInstanceAdmin,
  membershipFor,
} from "../membership";
import { cleanCapabilities } from "../membership-shared";
import { resolvePublicBaseUrl } from "../public-url";
import type {
  Capability,
  RegistrationLink,
  Role,
} from "../types";

/**
 * How long a freshly minted registration link stays usable. Expiry is automatic:
 * every read path and the consume `UPDATE` filter on `expires_at >= now()`, so a
 * stale link dies on its own with no sweep job to run.
 */
const REGISTRATION_TTL_HOURS = 24;

/** A team member projected for the client (no password hash, no email). */
export interface MemberDTO {
  userId: string;
  membershipId: string;
  username: string;
  name: string;
  role: Role;
  capabilities: Capability[];
  /**
   * True for the team's ABSOLUTE owner — the founder who created the team (the
   * "crown" 👑). Derived from `teams.founder_user_id`, NOT from the role: a
   * member can hold the `owner` role without being the founder (an "assigned
   * owner"). The founder is immutable and unremovable; an assigned owner can be
   * managed/removed by any owner. Exactly one member per team has this true
   * (zero only on a legacy team whose founder account was deleted).
   */
  isPrimaryOwner: boolean;
  /**
   * True if this user is a global instance admin. Surfaced here purely so the
   * member list can mark them with a badge (🛡️) — it grants NO extra authority
   * inside the team (instance-admin power stays global and orthogonal to the
   * team capability model).
   */
  isInstanceAdmin: boolean;
  avatarColor: string;
  createdAt: string;
}

/** A registered user as shown in the add-member search (username only). */
export interface UserSearchResult {
  userId: string;
  username: string;
  name: string;
  avatarColor: string;
  /** Their home team's name, to disambiguate identical display names. */
  teamName: string | null;
}

/** A registered user as shown in the global Users list (no email). */
export interface GlobalUserDTO {
  userId: string;
  username: string;
  name: string;
  avatarColor: string;
  teamCount: number;
  isInstanceAdmin: boolean;
  /** Owns the instance — their row is closed to every other admin. */
  isInstanceOwner: boolean;
  suspended: boolean;
  canExposePorts: boolean;
  canMountHostVolumes: boolean;
  createdAt: string;
}

/** Full per-user detail for the admin user editor (email IS included here). */
export interface UserDetailDTO {
  userId: string;
  username: string;
  name: string;
  /** Shown ONLY in the admin detail view — never in lists or search. */
  email: string;
  avatarColor: string;
  isInstanceAdmin: boolean;
  /** Owns the instance — their row is closed to every other admin. */
  isInstanceOwner: boolean;
  suspended: boolean;
  canExposePorts: boolean;
  canMountHostVolumes: boolean;
  createdAt: string;
  teams: { teamId: string; teamName: string; role: Role }[];
  recentActivity: { message: string; createdAt: string }[];
}

/** How a registration link decides the registrant's team(s). */
export type RegistrationMode = "own_team" | "existing_teams";

/** One pre-assigned team (+ role/capabilities) on an `existing_teams` link. */
export interface RegistrationTeamAssignment {
  teamId: string;
  role: Role;
  capabilities?: Capability[];
}

export interface RegistrationLinkDTO {
  id: string;
  status: RegistrationLink["status"];
  mode: RegistrationMode;
  /** For `existing_teams`: the names of the (still-existing) assigned teams. */
  teamNames: string[];
  createdBy: string;
  usedByUsername: string | null;
  expiresAt: string;
  createdAt: string;
}

/** Public, display-only view of a registration link for the /register page. */
export interface RegistrationLinkInfo {
  valid: boolean;
  mode: RegistrationMode;
  /** For `existing_teams`: the names of the teams the registrant will join. */
  teamNames: string[];
}

/**
 * The username to attribute an audit entry to. The actor is ALWAYS the current
 * request's user (every caller derives the acting membership from
 * `requireCapability`/`requireInstanceAdmin`), so this resolves it through the
 * relational, React-cached `getCurrentUser()` rather than a now-stale JSONB scan
 * (relational-store PLAN cut-set (b): identity is relational).
 */
async function actorUsername(): Promise<string> {
  return (await getCurrentUser())?.username ?? "an admin";
}

/**
 * Batch-load each membership's capabilities from the junction in ONE query
 * (relational-store PLAN §6 "N+1 on capabilities"). Returns membershipId → caps.
 */
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

/* ------------------------------------------------------------------ */
/* Team members                                                        */
/* ------------------------------------------------------------------ */

/** Members of the active team. Email is never projected to the client. */
export async function listMembers(): Promise<MemberDTO[]> {
  const teamId = await requireActiveTeamId();
  const db = getDb();
  const founderId = await teamFounderUserId(db, teamId);
  const rows = await db
    .select({
      membershipId: membershipsTable.id,
      role: membershipsTable.role,
      createdAt: membershipsTable.createdAt,
      userId: usersTable.id,
      username: usersTable.username,
      name: usersTable.name,
      avatarColor: usersTable.avatarColor,
      isInstanceAdmin: usersTable.isInstanceAdmin,
    })
    .from(membershipsTable)
    .innerJoin(usersTable, eq(usersTable.id, membershipsTable.userId))
    .where(eq(membershipsTable.teamId, teamId))
    .orderBy(membershipsTable.createdAt);
  const caps = await capabilitiesByMembership(
    db,
    rows.map((r) => r.membershipId),
  );
  return rows.map((r) => ({
    userId: r.userId,
    membershipId: r.membershipId,
    username: r.username,
    name: r.name,
    role: r.role as Role,
    capabilities: caps.get(r.membershipId) ?? [],
    isPrimaryOwner: r.userId === founderId,
    isInstanceAdmin: r.isInstanceAdmin ?? false,
    avatarColor: r.avatarColor,
    createdAt: r.createdAt,
  }));
}

/**
 * The user id of a team's founder (absolute owner / "crown"), or null if the
 * team predates the column and was never backfilled, or its founder's account
 * was deleted. Read straight from `teams.founder_user_id` — the single source of
 * truth for the absolute-owner distinction. Accepts the live db or a tx so the
 * mutation paths can read it under the same transaction as their guards.
 */
async function teamFounderUserId(
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

/**
 * List registered users available to add to the active team, matching on
 * USERNAME (and display name) only — emails are never searched or returned.
 * Excludes users already in the team. An empty query returns every available
 * user so the picker is populated from the start; a non-empty query filters
 * that roster. Each result carries the user's home-team name so two identical
 * display names stay distinguishable without exposing an email.
 */
export async function searchUsers(query: string): Promise<UserSearchResult[]> {
  const teamId = await requireActiveTeamId();
  await requireCapability("manage_members");
  const q = query.trim().toLowerCase();
  const db = getDb();

  // Users NOT already in the team.
  const inTeam = db
    .select({ userId: membershipsTable.userId })
    .from(membershipsTable)
    .where(eq(membershipsTable.teamId, teamId));
  const candidates = await db
    .select({
      id: usersTable.id,
      username: usersTable.username,
      name: usersTable.name,
      avatarColor: usersTable.avatarColor,
    })
    .from(usersTable)
    .where(notInArray(usersTable.id, inTeam))
    // Most recently created first, so the picker opens on the newest users
    // (the add-member dialog shows ~3 and scrolls for the rest).
    .orderBy(desc(usersTable.createdAt));

  const filtered = candidates.filter(
    (u) =>
      !q ||
      u.username.toLowerCase().includes(q) ||
      u.name.toLowerCase().includes(q),
  );
  if (filtered.length === 0) return [];

  // Home team per candidate = the team they own, else any team they're in.
  const candidateIds = filtered.map((u) => u.id);
  const mine = await db
    .select({
      userId: membershipsTable.userId,
      role: membershipsTable.role,
      teamName: teamsTable.name,
    })
    .from(membershipsTable)
    .innerJoin(teamsTable, eq(teamsTable.id, membershipsTable.teamId))
    .where(inArray(membershipsTable.userId, candidateIds));
  const homeByUser = new Map<string, string>();
  const ownedSet = new Set<string>();
  for (const m of mine) {
    // Prefer the team they own; otherwise keep the first seen.
    if (m.role === "owner" && !ownedSet.has(m.userId)) {
      homeByUser.set(m.userId, m.teamName);
      ownedSet.add(m.userId);
    } else if (!homeByUser.has(m.userId)) {
      homeByUser.set(m.userId, m.teamName);
    }
  }

  return filtered.map((u) => ({
    userId: u.id,
    username: u.username,
    name: u.name,
    avatarColor: u.avatarColor,
    teamName: homeByUser.get(u.id) ?? null,
  }));
}

/** Add an already-registered user to the active team with a role + capabilities. */
export async function addExistingMember(input: {
  userId: string;
  role: Role;
  capabilities?: Capability[];
}): Promise<MemberDTO> {
  const { membership } = await requireCapability("manage_members");
  const teamId = membership.teamId;
  // Granting the `owner` role is escalation — only an existing owner (the founder
  // or an assigned owner) may add another owner. A plain `manage_members` holder
  // can add members/viewers but cannot mint an owner above their own rank.
  if (input.role === "owner" && membership.role !== "owner")
    throw new Error("Only an owner can add another owner");
  const caps = cleanCapabilities(input.capabilities, input.role);
  const db = getDb();
  const targetRows = await db
    .select({
      id: usersTable.id,
      username: usersTable.username,
      name: usersTable.name,
      avatarColor: usersTable.avatarColor,
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
        role: input.role,
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
    await actorUsername(),
    null,
    teamId,
  );
  return {
    userId: target.id,
    membershipId,
    username: target.username,
    name: target.name,
    role: input.role,
    capabilities: caps,
    // A freshly added member is never the founder (the team already has one).
    isPrimaryOwner: false,
    isInstanceAdmin: target.isInstanceAdmin ?? false,
    avatarColor: target.avatarColor,
    createdAt: now,
  };
}

/* ------------------------------------------------------------------ */
/* Membership edits                                                    */
/* ------------------------------------------------------------------ */

// Administrative capabilities a team must never be left with zero holders of,
// or it locks itself out of member/team management irrecoverably.
const CRITICAL_CAPABILITIES: Capability[] = ["manage_members", "manage_team"];
const CRITICAL_LABEL: Record<string, string> = {
  manage_members: "manage members",
  manage_team: "manage the team",
};

/**
 * Assert that, after the proposed change to `targetUserId`'s membership, the
 * team still has at least one holder of each critical admin capability — under a
 * `SELECT … FOR UPDATE` lock over the holder set so two concurrent demotions
 * serialize (relational-store PLAN §4 "count-invariants"). A lost-update race
 * that READ COMMITTED alone would let through (both demotions see the other's
 * row still valid, both commit → zero holders) is blocked: the second demotion
 * waits on the lock, then re-evaluates against the post-commit holder set.
 *
 * `nextCaps` is the target's capabilities after the change, or null if the
 * target is being removed entirely. MUST run inside the caller's `db.transaction`
 * so the lock is held until commit.
 */
async function assertAdminCoverage(
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
    const targetStillHolds =
      nextCaps !== null && nextCaps.includes(cap);
    const others = holders.filter((h) => h.userId !== targetUserId);
    if (others.length === 0 && !targetStillHolds) {
      throw new Error(
        `The team must keep at least one member who can ${CRITICAL_LABEL[cap]}`,
      );
    }
  }
}

/** Change a member's role and/or capabilities within the active team. */
export async function updateMember(input: {
  userId: string;
  role: Role;
  capabilities?: Capability[];
}): Promise<void> {
  const { teamId, membership } = await requireCapability("manage_members");
  const actorIsOwner = membership.role === "owner";
  const caps = cleanCapabilities(input.capabilities, input.role);
  await getDb().transaction(async (tx) => {
    const founderId = await teamFounderUserId(tx, teamId);
    const rows = await tx
      .select({ id: membershipsTable.id, role: membershipsTable.role })
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
    // The ABSOLUTE owner (founder / "crown") is immutable: their role and
    // permissions can't be changed by anyone — including themselves and instance
    // admins — so the creator can never be demoted or locked out of their team.
    if (input.userId === founderId) {
      throw new Error(
        "The team's primary owner's role and permissions can't be changed.",
      );
    }
    // An (assigned) owner outranks non-owners: only another owner may change an
    // owner's permissions. A plain `manage_members` holder can manage non-owners
    // but cannot touch any owner.
    if (m.role === "owner" && !actorIsOwner) {
      throw new Error("Only an owner can change another owner's permissions.");
    }
    // Promoting someone to the `owner` role is escalation — only an owner may do
    // it (so a non-owner manager can't mint an owner above their own rank).
    if (input.role === "owner" && !actorIsOwner) {
      throw new Error("Only an owner can grant the owner role.");
    }
    await assertAdminCoverage(tx, teamId, input.userId, caps);
    await tx
      .update(membershipsTable)
      .set({ role: input.role })
      .where(eq(membershipsTable.id, m.id));
    await tx
      .delete(membershipCapabilitiesTable)
      .where(eq(membershipCapabilitiesTable.membershipId, m.id));
    await tx
      .insert(membershipCapabilitiesTable)
      .values(caps.map((c) => ({ membershipId: m.id, capability: c })));
  });
}

/** Remove a member from the active team (does not delete their account). */
export async function removeMember(userId: string): Promise<void> {
  const { teamId, userId: actingUserId, membership } = await requireCapability(
    "manage_members",
  );
  const actorIsOwner = membership.role === "owner";
  if (userId === actingUserId)
    throw new Error("You can't remove yourself from the team");
  let username = "";
  await getDb().transaction(async (tx) => {
    const founderId = await teamFounderUserId(tx, teamId);
    const rows = await tx
      .select({ id: membershipsTable.id, role: membershipsTable.role })
      .from(membershipsTable)
      .where(
        and(
          eq(membershipsTable.userId, userId),
          eq(membershipsTable.teamId, teamId),
        ),
      )
      .limit(1);
    const m = rows[0];
    if (!m) throw new Error("Member not found");
    // The ABSOLUTE owner (founder / "crown") can never be removed by anyone —
    // including instance admins — so the team always keeps its creator.
    if (userId === founderId) {
      throw new Error("The team's primary owner can't be removed.");
    }
    // An (assigned) owner outranks non-owners: only another owner may remove an
    // owner. Assigned owners can remove each other; the founder stays protected
    // by the guard above. A non-owner manager can remove only non-owners.
    if (m.role === "owner" && !actorIsOwner) {
      throw new Error("Only an owner can remove another owner.");
    }
    await assertAdminCoverage(tx, teamId, userId, null);
    const u = await tx
      .select({ username: usersTable.username })
      .from(usersTable)
      .where(eq(usersTable.id, userId))
      .limit(1);
    username = u[0]?.username ?? "";
    // membership_capabilities cascades on the membership FK.
    await tx
      .delete(membershipsTable)
      .where(eq(membershipsTable.id, m.id));
  });
  await recordActivity(
    "member",
    `Removed ${username || "a member"} from the team`,
    await actorUsername(),
    null,
    teamId,
  );
}

/* ------------------------------------------------------------------ */
/* Global users (settings)                                             */
/* ------------------------------------------------------------------ */

/**
 * Every registered user on the instance (no email exposed). Visible only to
 * instance admins. Used by the Settings → Users tab.
 */
export async function listAllUsers(): Promise<GlobalUserDTO[]> {
  await requireInstanceAdmin();
  const db = getDb();
  const users = await db
    .select({
      id: usersTable.id,
      username: usersTable.username,
      name: usersTable.name,
      avatarColor: usersTable.avatarColor,
      isInstanceAdmin: usersTable.isInstanceAdmin,
      suspended: usersTable.suspended,
      canExposePorts: usersTable.canExposePorts,
      canMountHostVolumes: usersTable.canMountHostVolumes,
      createdAt: usersTable.createdAt,
    })
    .from(usersTable)
    .orderBy(usersTable.createdAt);
  const counts = await db
    .select({
      userId: membershipsTable.userId,
      n: count(),
    })
    .from(membershipsTable)
    .groupBy(membershipsTable.userId);
  const countByUser = new Map(counts.map((c) => [c.userId, Number(c.n)]));
  const ownerUserId = await instanceOwnerUserId();
  return users.map((u) => ({
    userId: u.id,
    username: u.username,
    name: u.name,
    avatarColor: u.avatarColor,
    teamCount: countByUser.get(u.id) ?? 0,
    isInstanceAdmin: u.isInstanceAdmin ?? false,
    isInstanceOwner: u.id === ownerUserId,
    suspended: u.suspended ?? false,
    canExposePorts: u.canExposePorts ?? false,
    canMountHostVolumes: u.canMountHostVolumes ?? false,
    createdAt: u.createdAt,
  }));
}

/**
 * Full detail for one user, for the admin editor: teams & roles, account
 * metadata, the email (admin-only — never in lists/search), and recent
 * activity by that user across the instance. Instance-admin only.
 */
export async function getUserDetail(userId: string): Promise<UserDetailDTO> {
  await requireInstanceAdmin();
  const db = getDb();
  const urows = await db
    .select({
      id: usersTable.id,
      username: usersTable.username,
      name: usersTable.name,
      email: usersTable.email,
      avatarColor: usersTable.avatarColor,
      isInstanceAdmin: usersTable.isInstanceAdmin,
      suspended: usersTable.suspended,
      canExposePorts: usersTable.canExposePorts,
      canMountHostVolumes: usersTable.canMountHostVolumes,
      createdAt: usersTable.createdAt,
    })
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);
  const u = urows[0];
  if (!u) throw new Error("User not found");
  const teamRows = await db
    .select({
      teamId: membershipsTable.teamId,
      teamName: teamsTable.name,
      role: membershipsTable.role,
    })
    .from(membershipsTable)
    .innerJoin(teamsTable, eq(teamsTable.id, membershipsTable.teamId))
    .where(eq(membershipsTable.userId, userId));
  // Activity is relational (cut-set e); attributed by actor = username.
  const recentActivity = (await listActivityByActor(u.username, 10)).map((a) => ({
    message: a.message,
    createdAt: a.createdAt,
  }));
  return {
    userId: u.id,
    username: u.username,
    name: u.name,
    email: u.email,
    avatarColor: u.avatarColor,
    isInstanceAdmin: u.isInstanceAdmin ?? false,
    isInstanceOwner: u.id === (await instanceOwnerUserId()),
    suspended: u.suspended ?? false,
    canExposePorts: u.canExposePorts ?? false,
    canMountHostVolumes: u.canMountHostVolumes ?? false,
    createdAt: u.createdAt,
    teams: teamRows.map((t) => ({
      teamId: t.teamId,
      teamName: t.teamName ?? "(unknown)",
      role: t.role as Role,
    })),
    recentActivity,
  };
}

/**
 * Edit a user's global-scoped attributes: instance-admin flag, suspended
 * status, and an optional admin password reset. Instance-admin only.
 *
 * Guards against locking the platform out of administration: the last instance
 * admin cannot demote or suspend themselves, and you cannot remove the final
 * admin via any single edit. The active-admin count-invariant is a lost-update
 * race (relational-store PLAN §4), so the candidate admin set is locked with
 * `SELECT … FOR UPDATE` inside the transaction — two concurrent demotions
 * serialize and the second re-evaluates against the post-commit count.
 *
 * That invariant alone does NOT stop a takeover, which is what the instance-owner
 * guards below are for: it only requires one active admin to survive, and the
 * attacking admin is that survivor. The owner's row is therefore closed to every
 * other admin outright (see lib/data/instance-owner.ts).
 */
export async function updateUserAdmin(input: {
  userId: string;
  isInstanceAdmin: boolean;
  suspended: boolean;
  canExposePorts: boolean;
  canMountHostVolumes: boolean;
  newPassword?: string;
}): Promise<void> {
  const { userId: actingUserId } = await requireInstanceAdmin();
  const newPassword = input.newPassword?.trim() ? input.newPassword : null;
  if (newPassword && newPassword.length < 8)
    throw new Error("Choose a password of at least 8 characters");

  await getDb().transaction(async (tx) => {
    const target = (
      await tx
        .select({ id: usersTable.id })
        .from(usersTable)
        .where(eq(usersTable.id, input.userId))
        .for("update")
        .limit(1)
    )[0];
    if (!target) throw new Error("User not found");

    // The instance owner's crown, read under the same transaction as the write it
    // vetoes so a concurrent transferInstanceOwner can't slip between the two.
    const ownerUserId = await instanceOwnerUserId(tx);

    // NOBODY edits the owner's row but the owner. Not "cannot demote" — cannot
    // touch: demote, suspend and password-reset are three routes to the same
    // takeover (the last-admin invariant is satisfied by the attacker themselves,
    // and a reset hash hands over the account outright), and there is no benign
    // edit left once those are gone — the owner is an admin, so the two grant
    // flags are already implied for them (see hasGrant in membership.ts). One
    // rule, no partial states, and a UI message a non-expert can act on.
    if (ownerUserId !== null && input.userId === ownerUserId && actingUserId !== ownerUserId)
      throw new Error(
        "Only the instance owner can edit the instance owner's account",
      );

    // The owner can't uncrown themselves by dropping their own admin flag — the
    // same rule the team founder has (a founder cannot be demoted even by
    // themselves). Ownership leaves only through transferInstanceOwner, which
    // hands it to a named successor instead of leaving the instance unowned.
    if (input.userId === ownerUserId && !input.isInstanceAdmin)
      throw new Error(
        "The instance owner is always an instance admin. Transfer ownership first.",
      );

    // An admin can't suspend or demote themselves into a lockout corner.
    if (input.userId === actingUserId && input.suspended)
      throw new Error("You can't suspend your own account");

    // Lockout guard: the instance must always retain at least one ACTIVE
    // (non-suspended) instance admin. Lock the candidate set — every current
    // admin PLUS the target (the target may be a *promotion* not yet in the
    // admin set) — and count active admins as they WOULD be after this edit.
    const candidates = await tx
      .select({
        id: usersTable.id,
        isInstanceAdmin: usersTable.isInstanceAdmin,
        suspended: usersTable.suspended,
      })
      .from(usersTable)
      .where(
        or(eq(usersTable.isInstanceAdmin, true), eq(usersTable.id, input.userId)),
      )
      .for("update");
    const activeAdminsAfter = candidates.filter((x) => {
      const isAdmin =
        x.id === target.id ? input.isInstanceAdmin : (x.isInstanceAdmin ?? false);
      const isSuspended =
        x.id === target.id ? input.suspended : (x.suspended ?? false);
      return isAdmin && !isSuspended;
    });
    if (activeAdminsAfter.length === 0)
      throw new Error("The instance must keep at least one active admin");

    await tx
      .update(usersTable)
      .set({
        isInstanceAdmin: input.isInstanceAdmin,
        suspended: input.suspended,
        canExposePorts: input.canExposePorts,
        canMountHostVolumes: input.canMountHostVolumes,
        ...(newPassword ? { passwordHash: hashPassword(newPassword) } : {}),
      })
      .where(eq(usersTable.id, input.userId));
  });

  const target = (
    await getDb()
      .select({ username: usersTable.username })
      .from(usersTable)
      .where(eq(usersTable.id, input.userId))
      .limit(1)
  )[0]!;
  await recordActivity(
    "member",
    `Updated user @${target.username}` +
      (newPassword ? " (password reset)" : ""),
    await actorUsername(),
    null,
  );
}

/* ------------------------------------------------------------------ */
/* Registration links (new global accounts + own team)                */
/* ------------------------------------------------------------------ */

export interface MintRegistrationResult {
  /** Absolute /register/<token> URL — always returned for copying/sharing. */
  link: string;
}

const MAX_REGISTRATION_TEAMS = 50;

/**
 * Mint a single-use registration link. Instance-admin only.
 *
 * `own_team` (default): the registrant names and owns a fresh team at
 * registration — the historical behavior. `existing_teams`: the admin
 * pre-assigns the registrant to one or more existing teams (with a role +
 * capabilities each); the registrant is NOT asked for a team name and joins
 * those teams as a member. The choice is baked into the link via its `mode` +
 * `registration_link_teams` rows and cannot be changed by the registrant.
 */
export async function mintRegistrationLink(input: {
  mode: RegistrationMode;
  teamAssignments?: RegistrationTeamAssignment[];
}): Promise<MintRegistrationResult> {
  await requireInstanceAdmin();
  const createdBy = await actorUsername();
  const rawToken = randomToken(24);
  const now = nowIso();
  const linkId = newId("reg");
  const expiresAt = new Date(
    Date.now() + REGISTRATION_TTL_HOURS * 3_600_000,
  ).toISOString();
  const baseRow = {
    id: linkId,
    tokenHash: sha256Hex(rawToken),
    status: "pending",
    createdBy,
    usedByUsername: null,
    expiresAt,
    createdAt: now,
    usedAt: null,
  } as const;

  if (input.mode === "existing_teams") {
    // De-dupe by team (the unique index forbids two rows for one team on a link)
    // and validate every team still exists before writing anything.
    const byTeam = new Map<string, RegistrationTeamAssignment>();
    for (const a of input.teamAssignments ?? []) byTeam.set(a.teamId, a);
    const assignments = [...byTeam.values()];
    if (assignments.length === 0)
      throw new Error("Select at least one team for the new user");
    if (assignments.length > MAX_REGISTRATION_TEAMS)
      throw new Error("Too many teams selected");
    // A new user joins existing teams as member/viewer ONLY — never as an owner.
    // The UI restricts this, but the role arrives from the client, so the server
    // must enforce it too: granting the owner role is an escalation reserved for
    // an existing owner of the team (see addExistingMember/updateMember), not
    // something an admin pre-bakes into a self-service registration link.
    for (const a of assignments) {
      if (a.role !== "member" && a.role !== "viewer")
        throw new Error("A new user can only join a team as a member or viewer");
    }
    // The minting admin may only place a new user into teams THEY belong to — an
    // instance admin is NOT implicitly a member of every team. The dialog only
    // lists the viewer's teams, but the ids arrive from the client, so enforce
    // it server-side (membership also implies the team still exists).
    const me = await getCurrentUser();
    if (!me) throw new Error("Not authenticated");
    const myTeamRows = await getDb()
      .select({ teamId: membershipsTable.teamId })
      .from(membershipsTable)
      .where(eq(membershipsTable.userId, me.id));
    const myTeamIds = new Set(myTeamRows.map((r) => r.teamId));
    for (const a of assignments) {
      if (!myTeamIds.has(a.teamId))
        throw new Error("You can only add new users to teams you belong to");
    }
    const ids = assignments.map((a) => a.teamId);
    const found = await getDb()
      .select({ id: teamsTable.id })
      .from(teamsTable)
      .where(inArray(teamsTable.id, ids));
    const foundSet = new Set(found.map((r) => r.id));
    if (foundSet.size !== ids.length)
      throw new Error("One or more selected teams no longer exist");

    await getDb().transaction(async (tx) => {
      await tx
        .insert(registrationLinksTable)
        .values({ ...baseRow, mode: "existing_teams" });
      for (const a of assignments) {
        const linkTeamId = newId("rlt");
        await tx.insert(registrationLinkTeamsTable).values({
          id: linkTeamId,
          linkId,
          teamId: a.teamId,
          role: a.role,
        });
        const caps = cleanCapabilities(a.capabilities, a.role);
        await tx
          .insert(registrationLinkTeamCapabilitiesTable)
          .values(caps.map((c) => ({ linkTeamId, capability: c })));
      }
    });
  } else {
    await getDb()
      .insert(registrationLinksTable)
      .values({ ...baseRow, mode: "own_team" });
  }

  const base = resolvePublicBaseUrl(await headers());
  return { link: `${base}/register/${rawToken}` };
}

/** Pending + recent registration links for the Settings → Users tab. */
export async function listRegistrationLinks(): Promise<RegistrationLinkDTO[]> {
  await requireInstanceAdmin();
  const rows = await getDb()
    .select({
      id: registrationLinksTable.id,
      status: registrationLinksTable.status,
      mode: registrationLinksTable.mode,
      createdBy: registrationLinksTable.createdBy,
      usedByUsername: registrationLinksTable.usedByUsername,
      expiresAt: registrationLinksTable.expiresAt,
      createdAt: registrationLinksTable.createdAt,
    })
    .from(registrationLinksTable)
    .orderBy(desc(registrationLinksTable.createdAt));

  // Batch-load assigned team names for the existing_teams links in one query.
  const linkIds = rows.map((l) => l.id);
  const namesByLink = new Map<string, string[]>();
  if (linkIds.length > 0) {
    const teamRows = await getDb()
      .select({
        linkId: registrationLinkTeamsTable.linkId,
        name: teamsTable.name,
      })
      .from(registrationLinkTeamsTable)
      .innerJoin(teamsTable, eq(teamsTable.id, registrationLinkTeamsTable.teamId))
      .where(inArray(registrationLinkTeamsTable.linkId, linkIds))
      .orderBy(asc(teamsTable.name));
    for (const r of teamRows) {
      const list = namesByLink.get(r.linkId) ?? [];
      list.push(r.name);
      namesByLink.set(r.linkId, list);
    }
  }

  return rows.map((l) => ({
    id: l.id,
    status: l.status as RegistrationLink["status"],
    mode: l.mode as RegistrationMode,
    teamNames: namesByLink.get(l.id) ?? [],
    createdBy: l.createdBy,
    usedByUsername: l.usedByUsername,
    expiresAt: l.expiresAt,
    createdAt: l.createdAt,
  }));
}

/** Revoke a pending registration link. */
export async function revokeRegistrationLink(id: string): Promise<void> {
  await requireInstanceAdmin();
  const updated = await getDb()
    .update(registrationLinksTable)
    .set({ status: "revoked" })
    .where(
      and(
        eq(registrationLinksTable.id, id),
        eq(registrationLinksTable.status, "pending"),
      ),
    )
    .returning({ id: registrationLinksTable.id });
  // Match the prior behavior: a non-pending link is a no-op, but a missing id
  // is an error.
  if (updated.length === 0) {
    const exists = await getDb()
      .select({ id: registrationLinksTable.id })
      .from(registrationLinksTable)
      .where(eq(registrationLinksTable.id, id))
      .limit(1);
    if (exists.length === 0) throw new Error("Link not found");
  }
}

/** True if a pending, unexpired registration link exists for the raw token. */
export async function isRegistrationTokenValid(rawToken: string): Promise<boolean> {
  const hash = sha256Hex(rawToken);
  const rows = await getDb()
    .select({ id: registrationLinksTable.id })
    .from(registrationLinksTable)
    .where(
      and(
        eq(registrationLinksTable.tokenHash, hash),
        eq(registrationLinksTable.status, "pending"),
        gte(registrationLinksTable.expiresAt, sql`now()`),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * Public, display-only view of a registration link for the /register page: is it
 * usable, which mode, and (for `existing_teams`) the names of the teams the
 * registrant will join. No secrets. An `existing_teams` link whose teams were
 * all deleted reports `valid: false` — there is nothing left to join.
 */
export async function getRegistrationLinkInfo(
  rawToken: string,
): Promise<RegistrationLinkInfo> {
  const hash = sha256Hex(rawToken);
  const rows = await getDb()
    .select({
      id: registrationLinksTable.id,
      mode: registrationLinksTable.mode,
    })
    .from(registrationLinksTable)
    .where(
      and(
        eq(registrationLinksTable.tokenHash, hash),
        eq(registrationLinksTable.status, "pending"),
        gte(registrationLinksTable.expiresAt, sql`now()`),
      ),
    )
    .limit(1);
  const link = rows[0];
  if (!link) return { valid: false, mode: "own_team", teamNames: [] };
  const mode = link.mode as RegistrationMode;
  if (mode !== "existing_teams") return { valid: true, mode, teamNames: [] };

  const teamRows = await getDb()
    .select({ name: teamsTable.name })
    .from(registrationLinkTeamsTable)
    .innerJoin(teamsTable, eq(teamsTable.id, registrationLinkTeamsTable.teamId))
    .where(eq(registrationLinkTeamsTable.linkId, link.id))
    .orderBy(asc(teamsTable.name));
  const teamNames = teamRows.map((r) => r.name);
  // Every assigned team was deleted before use → nothing to join → unusable.
  if (teamNames.length === 0)
    return { valid: false, mode: "existing_teams", teamNames: [] };
  return { valid: true, mode: "existing_teams", teamNames };
}

/**
 * The per-team role + capability assignments baked into a pending
 * `existing_teams` link, resolved against teams that still exist. Used by the
 * register-through-link flow to seed the new account's memberships. Returns []
 * if the token is not a pending link (or all its teams are gone).
 */
export async function getRegistrationLinkAssignments(
  rawToken: string,
): Promise<{ teamId: string; role: Role; capabilities: Capability[] }[]> {
  const hash = sha256Hex(rawToken);
  const linkRows = await getDb()
    .select({ id: registrationLinksTable.id })
    .from(registrationLinksTable)
    .where(
      and(
        eq(registrationLinksTable.tokenHash, hash),
        eq(registrationLinksTable.status, "pending"),
        gte(registrationLinksTable.expiresAt, sql`now()`),
      ),
    )
    .limit(1);
  const link = linkRows[0];
  if (!link) return [];

  const teamRows = await getDb()
    .select({
      linkTeamId: registrationLinkTeamsTable.id,
      teamId: registrationLinkTeamsTable.teamId,
      role: registrationLinkTeamsTable.role,
    })
    .from(registrationLinkTeamsTable)
    // INNER join drops assignments whose team was deleted after minting.
    .innerJoin(teamsTable, eq(teamsTable.id, registrationLinkTeamsTable.teamId))
    .where(eq(registrationLinkTeamsTable.linkId, link.id));
  if (teamRows.length === 0) return [];

  const capsByLinkTeam = new Map<string, Capability[]>();
  const capRows = await getDb()
    .select({
      linkTeamId: registrationLinkTeamCapabilitiesTable.linkTeamId,
      capability: registrationLinkTeamCapabilitiesTable.capability,
    })
    .from(registrationLinkTeamCapabilitiesTable)
    .where(
      inArray(
        registrationLinkTeamCapabilitiesTable.linkTeamId,
        teamRows.map((r) => r.linkTeamId),
      ),
    );
  for (const r of capRows) {
    const list = capsByLinkTeam.get(r.linkTeamId) ?? [];
    list.push(r.capability as Capability);
    capsByLinkTeam.set(r.linkTeamId, list);
  }

  return teamRows.map((r) => ({
    teamId: r.teamId,
    role: r.role as Role,
    capabilities: capsByLinkTeam.get(r.linkTeamId) ?? [],
  }));
}

/**
 * Consume a registration link inside the SAME `db.transaction` that creates the
 * account+team (via createAccountWithTeam's `guard`), so check-create-consume is
 * one atomic critical section (relational-store PLAN §1/§3). A single-use link
 * is consumed by a conditional `UPDATE … WHERE status='pending' AND
 * expires_at>=now() RETURNING`: a concurrent double-submit has both transactions
 * attempt it; the conditional matches exactly once, so the loser updates 0 rows
 * and throws here — its whole account+team insert rolls back. This replaces the
 * synchronous-mutate atomicity that closed the TOCTOU before the migration.
 */
export async function consumeRegistrationLink(
  tx: DbTx,
  rawToken: string,
  usedByUsername: string,
): Promise<void> {
  const hash = sha256Hex(rawToken);
  const updated = await tx
    .update(registrationLinksTable)
    .set({ status: "used", usedByUsername, usedAt: nowIso() })
    .where(
      and(
        eq(registrationLinksTable.tokenHash, hash),
        eq(registrationLinksTable.status, "pending"),
        gte(registrationLinksTable.expiresAt, sql`now()`),
      ),
    )
    .returning({ id: registrationLinksTable.id });
  if (updated.length === 0)
    throw new Error("This registration link is no longer valid");
}
