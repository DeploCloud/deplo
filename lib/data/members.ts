import "server-only";

import { headers } from "next/headers";
import { read, mutate } from "../store";
import { newId, nowIso } from "../ids";
import { sha256Hex, randomToken, hashPassword } from "../crypto";
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
  Membership,
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

/* ------------------------------------------------------------------ */
/* Team members                                                        */
/* ------------------------------------------------------------------ */

/** Members of the active team. Email is never projected to the client. */
export async function listMembers(): Promise<MemberDTO[]> {
  const teamId = await requireActiveTeamId();
  const d = read();
  return d.memberships
    .filter((m) => m.teamId === teamId)
    .map((m) => {
      const u = d.users.find((x) => x.id === m.userId);
      return u
        ? {
            userId: u.id,
            membershipId: m.id,
            username: u.username,
            name: u.name,
            role: m.role,
            capabilities: m.capabilities,
            avatarColor: u.avatarColor,
            createdAt: m.createdAt,
          }
        : null;
    })
    .filter((m): m is MemberDTO => m !== null)
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
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
  const d = read();
  const inTeam = new Set(
    d.memberships.filter((m) => m.teamId === teamId).map((m) => m.userId),
  );
  return d.users
    .filter((u) => !inTeam.has(u.id))
    .filter(
      (u) =>
        !q ||
        u.username.toLowerCase().includes(q) ||
        u.name.toLowerCase().includes(q),
    )
    .sort((a, b) => a.username.localeCompare(b.username))
    .map((u) => {
      // Their "home" team = the team they own, else any team they're in.
      const mine = d.memberships.filter((m) => m.userId === u.id);
      const owned = mine.find((m) => m.role === "owner") ?? mine[0];
      const home = owned
        ? d.teams.find((t) => t.id === owned.teamId)?.name ?? null
        : null;
      return {
        userId: u.id,
        username: u.username,
        name: u.name,
        avatarColor: u.avatarColor,
        teamName: home,
      };
    });
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
  const d = read();
  const target = d.users.find((u) => u.id === input.userId);
  if (!target) throw new Error("User not found");
  if (membershipFor(target.id, teamId))
    throw new Error("That user is already a member of this team");

  const now = nowIso();
  const newMembership: Membership = {
    id: newId("mbr"),
    userId: target.id,
    teamId,
    role: input.role,
    capabilities: caps,
    createdAt: now,
  };
  mutate((data) => {
    // Re-check inside the mutation against a double-add race.
    if (!data.memberships.some((m) => m.userId === target.id && m.teamId === teamId))
      data.memberships.push(newMembership);
  });
  recordActivity(
    "member",
    `Added ${target.username} to the team`,
    read().users.find((u) => u.id === membership.userId)?.username ?? "an admin",
    null,
    teamId,
  );
  return {
    userId: target.id,
    membershipId: newMembership.id,
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
 * team still has at least one holder of each critical admin capability.
 * `nextCaps` is the target's capabilities after the change, or null if the
 * target is being removed entirely.
 */
function assertAdminCoverage(
  memberships: Membership[],
  teamId: string,
  targetUserId: string,
  nextCaps: Capability[] | null,
): void {
  for (const cap of CRITICAL_CAPABILITIES) {
    const holders = memberships.filter(
      (m) => m.teamId === teamId && m.capabilities.includes(cap),
    );
    const stillHeld = holders.some((m) =>
      m.userId === targetUserId ? (nextCaps?.includes(cap) ?? false) : true,
    );
    if (!stillHeld) {
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
  mutate((d) => {
    const m = d.memberships.find(
      (x) => x.userId === input.userId && x.teamId === teamId,
    );
    if (!m) throw new Error("Member not found");
    assertAdminCoverage(d.memberships, teamId, input.userId, caps);
    m.role = input.role;
    m.capabilities = caps;
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
  mutate((d) => {
    const m = d.memberships.find(
      (x) => x.userId === userId && x.teamId === teamId,
    );
    if (!m) throw new Error("Member not found");
    assertAdminCoverage(d.memberships, teamId, userId, null);
    username = d.users.find((u) => u.id === userId)?.username ?? "";
    d.memberships = d.memberships.filter((x) => x.id !== m.id);
  });
  recordActivity(
    "member",
    `Removed ${username || "a member"} from the team`,
    read().users.find((u) => u.id === actingUserId)?.username ?? "an admin",
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
  const d = read();
  return d.users
    .map((u) => ({
      userId: u.id,
      username: u.username,
      name: u.name,
      avatarColor: u.avatarColor,
      teamCount: d.memberships.filter((m) => m.userId === u.id).length,
      isInstanceAdmin: u.isInstanceAdmin ?? false,
      suspended: u.suspended ?? false,
      canExposePorts: u.canExposePorts ?? false,
      canMountHostVolumes: u.canMountHostVolumes ?? false,
      createdAt: u.createdAt,
    }))
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
}

/**
 * Full detail for one user, for the admin editor: teams & roles, account
 * metadata, the email (admin-only — never in lists/search), and recent
 * activity by that user across the instance. Instance-admin only.
 */
export async function getUserDetail(userId: string): Promise<UserDetailDTO> {
  await requireInstanceAdmin();
  const d = read();
  const u = d.users.find((x) => x.id === userId);
  if (!u) throw new Error("User not found");
  const teams = d.memberships
    .filter((m) => m.userId === userId)
    .map((m) => ({
      teamId: m.teamId,
      teamName: d.teams.find((t) => t.id === m.teamId)?.name ?? "(unknown)",
      role: m.role,
    }));
  // Activity is attributed by actor = username; match on the user's handle.
  const recentActivity = d.activities
    .filter((a: Activity) => a.actor === u.username)
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
    teams,
    recentActivity,
  };
}

/**
 * Edit a user's global-scoped attributes: instance-admin flag, suspended
 * status, and an optional admin password reset. Instance-admin only.
 *
 * Guards against locking the platform out of administration: the last instance
 * admin cannot demote or suspend themselves, and you cannot remove the final
 * admin via any single edit.
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

  mutate((d) => {
    const u = d.users.find((x) => x.id === input.userId);
    if (!u) throw new Error("User not found");

    // An admin can't suspend or demote themselves into a lockout corner.
    if (input.userId === actingUserId && input.suspended)
      throw new Error("You can't suspend your own account");

    // Lockout guard: the instance must always retain at least one ACTIVE
    // (non-suspended) instance admin. Count active admins as they WOULD be
    // after this edit — so demoting/suspending the only effective admin is
    // refused even if a *suspended* admin pads the raw count.
    const activeAdminsAfter = d.users.filter((x) => {
      const isAdmin = x.id === u.id ? input.isInstanceAdmin : (x.isInstanceAdmin ?? false);
      const isSuspended = x.id === u.id ? input.suspended : (x.suspended ?? false);
      return isAdmin && !isSuspended;
    });
    if (activeAdminsAfter.length === 0)
      throw new Error("The instance must keep at least one active admin");

    u.isInstanceAdmin = input.isInstanceAdmin;
    u.suspended = input.suspended;
    u.canExposePorts = input.canExposePorts;
    u.canMountHostVolumes = input.canMountHostVolumes;
    if (newPassword) u.passwordHash = hashPassword(newPassword);
  });

  const actor =
    read().users.find((x) => x.id === actingUserId)?.username ?? "an admin";
  const target = read().users.find((x) => x.id === input.userId)!;
  recordActivity(
    "member",
    `Updated user @${target.username}` +
      (newPassword ? " (password reset)" : ""),
    actor,
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
  const { userId } = await requireInstanceAdmin();
  const createdBy =
    read().users.find((u) => u.id === userId)?.username ?? "an admin";
  const rawToken = randomToken(24);
  const now = nowIso();
  const link: RegistrationLink = {
    id: newId("reg"),
    tokenHash: sha256Hex(rawToken),
    status: "pending",
    createdBy,
    usedByUsername: null,
    expiresAt: new Date(Date.now() + REGISTRATION_TTL_DAYS * 86400_000).toISOString(),
    createdAt: now,
    usedAt: null,
  };
  mutate((d) => {
    d.registrationLinks ??= [];
    d.registrationLinks.push(link);
  });
  const base = resolvePublicBaseUrl(await headers());
  return { link: `${base}/register/${rawToken}` };
}

/** Pending + recent registration links for the Settings → Users tab. */
export async function listRegistrationLinks(): Promise<RegistrationLinkDTO[]> {
  await requireInstanceAdmin();
  return (read().registrationLinks ?? [])
    .slice()
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .map((l) => ({
      id: l.id,
      status: l.status,
      createdBy: l.createdBy,
      usedByUsername: l.usedByUsername,
      expiresAt: l.expiresAt,
      createdAt: l.createdAt,
    }));
}

/** Revoke a pending registration link. */
export async function revokeRegistrationLink(id: string): Promise<void> {
  await requireInstanceAdmin();
  mutate((d) => {
    const l = (d.registrationLinks ?? []).find((x) => x.id === id);
    if (!l) throw new Error("Link not found");
    if (l.status === "pending") l.status = "revoked";
  });
}

/** True if a pending, unexpired registration link exists for the raw token. */
export async function isRegistrationTokenValid(rawToken: string): Promise<boolean> {
  const hash = sha256Hex(rawToken);
  const l = (read().registrationLinks ?? []).find((x) => x.tokenHash === hash);
  return Boolean(
    l && l.status === "pending" && new Date(l.expiresAt).getTime() >= Date.now(),
  );
}

/**
 * Consume a registration link on a LIVE store draft: re-validate pending/expiry
 * and mark it used, throwing if invalid. Designed to be called from inside the
 * SAME `mutate()` that creates the account+team (via createAccountWithTeam's
 * `guard`), so check-create-consume is one atomic critical section — a
 * concurrent double-submit can never mint two accounts from one single-use link
 * (the loser throws here before anything is persisted).
 */
export function consumeRegistrationLinkInDraft(
  data: { registrationLinks?: RegistrationLink[] },
  rawToken: string,
  usedByUsername: string,
): void {
  const hash = sha256Hex(rawToken);
  const l = (data.registrationLinks ?? []).find((x) => x.tokenHash === hash);
  if (!l || l.status !== "pending")
    throw new Error("This registration link is no longer valid");
  if (new Date(l.expiresAt).getTime() < Date.now())
    throw new Error("This registration link has expired");
  l.status = "used";
  l.usedByUsername = usedByUsername;
  l.usedAt = nowIso();
}
