import "server-only";

import { headers } from "next/headers";
import { and, count, desc, eq, gte, inArray, notInArray, or, sql } from "drizzle-orm";
import { read } from "../store";
import { getDb, type DbTx } from "../db/client";
import {
  memberships as membershipsTable,
  membershipCapabilities as membershipCapabilitiesTable,
  registrationLinks as registrationLinksTable,
  teams as teamsTable,
  users as usersTable,
} from "../db/schema/control-plane";
import { newId, nowIso } from "../ids";
import { sha256Hex, randomToken, hashPassword } from "../crypto";
import { getCurrentUser } from "../auth";
import { recordActivity } from "./activity";
import {
  requireCapability,
  requireActiveTeamId,
  requireInstanceAdmin,
  membershipFor,
  capabilitiesForRole,
} from "../membership";
import { resolvePublicBaseUrl } from "../public-url";
import type {
  Activity,
  Capability,
  RegistrationLink,
  Role,
} from "../types";
import { ALL_CAPABILITIES } from "../types";

const REGISTRATION_TTL_DAYS = 14;

/** A team member projected for the client (no password hash, no email). */
export interface MemberDTO {
  userId: string;
  membershipId: string;
  username: string;
  name: string;
  role: Role;
  capabilities: Capability[];
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
  suspended: boolean;
  canExposePorts: boolean;
  canMountHostVolumes: boolean;
  createdAt: string;
  teams: { teamId: string; teamName: string; role: Role }[];
  recentActivity: { message: string; createdAt: string }[];
}

export interface RegistrationLinkDTO {
  id: string;
  status: RegistrationLink["status"];
  createdBy: string;
  usedByUsername: string | null;
  expiresAt: string;
  createdAt: string;
}

/** Sanitize an arbitrary capability list to known values, always implying view. */
function cleanCapabilities(caps: Capability[] | undefined, role: Role): Capability[] {
  const base = caps?.length ? caps : capabilitiesForRole(role);
  const set = new Set(base.filter((c) => ALL_CAPABILITIES.includes(c)));
  set.add("view");
  return ALL_CAPABILITIES.filter((c) => set.has(c));
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
  const rows = await db
    .select({
      membershipId: membershipsTable.id,
      role: membershipsTable.role,
      createdAt: membershipsTable.createdAt,
      userId: usersTable.id,
      username: usersTable.username,
      name: usersTable.name,
      avatarColor: usersTable.avatarColor,
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
    avatarColor: r.avatarColor,
    createdAt: r.createdAt,
  }));
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
    .orderBy(usersTable.username);

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
  const caps = cleanCapabilities(input.capabilities, input.role);
  const db = getDb();
  const targetRows = await db
    .select({
      id: usersTable.id,
      username: usersTable.username,
      name: usersTable.name,
      avatarColor: usersTable.avatarColor,
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
  const { teamId } = await requireCapability("manage_members");
  const caps = cleanCapabilities(input.capabilities, input.role);
  await getDb().transaction(async (tx) => {
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
    // The team's owner is immutable: their role and permissions can't be
    // changed by anyone (including themselves), so the founder can never be
    // demoted or lock themselves out of their own team.
    if (m.role === "owner") {
      throw new Error("The team owner's role and permissions can't be changed.");
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
  const { teamId, userId: actingUserId } = await requireCapability(
    "manage_members",
  );
  if (userId === actingUserId)
    throw new Error("You can't remove yourself from the team");
  let username = "";
  await getDb().transaction(async (tx) => {
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
    // The team's owner can never be removed (the founder is permanent).
    if (m.role === "owner") {
      throw new Error("The team owner can't be removed.");
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
  return users.map((u) => ({
    userId: u.id,
    username: u.username,
    name: u.name,
    avatarColor: u.avatarColor,
    teamCount: countByUser.get(u.id) ?? 0,
    isInstanceAdmin: u.isInstanceAdmin ?? false,
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
  // Activity is still JSONB (cut-set c/d); attributed by actor = username.
  const recentActivity = read()
    .activities.filter((a: Activity) => a.actor === u.username)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .slice(0, 10)
    .map((a) => ({ message: a.message, createdAt: a.createdAt }));
  return {
    userId: u.id,
    username: u.username,
    name: u.name,
    email: u.email,
    avatarColor: u.avatarColor,
    isInstanceAdmin: u.isInstanceAdmin ?? false,
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

/** Mint a single-use registration link. Instance-admin only. */
export async function mintRegistrationLink(): Promise<MintRegistrationResult> {
  await requireInstanceAdmin();
  const createdBy = await actorUsername();
  const rawToken = randomToken(24);
  const now = nowIso();
  await getDb().insert(registrationLinksTable).values({
    id: newId("reg"),
    tokenHash: sha256Hex(rawToken),
    status: "pending",
    createdBy,
    usedByUsername: null,
    expiresAt: new Date(
      Date.now() + REGISTRATION_TTL_DAYS * 86400_000,
    ).toISOString(),
    createdAt: now,
    usedAt: null,
  });
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
      createdBy: registrationLinksTable.createdBy,
      usedByUsername: registrationLinksTable.usedByUsername,
      expiresAt: registrationLinksTable.expiresAt,
      createdAt: registrationLinksTable.createdAt,
    })
    .from(registrationLinksTable)
    .orderBy(desc(registrationLinksTable.createdAt));
  return rows.map((l) => ({
    id: l.id,
    status: l.status as RegistrationLink["status"],
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
