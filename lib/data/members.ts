import "server-only";

// https://deplo.build/docs/guides/team/members

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
  appGrants as appGrantsTable,
  apps as appsTable,
  folderGrants as folderGrantsTable,
  folders as foldersTable,
  memberships as membershipsTable,
  membershipCapabilities as membershipCapabilitiesTable,
  projectGrants as projectGrantsTable,
  projects as projectsTable,
  teamRoles as teamRolesTable,
  teamRoleCapabilities as teamRoleCapabilitiesTable,
  registrationLinks as registrationLinksTable,
  registrationLinkTeams as registrationLinkTeamsTable,
  registrationLinkTeamCapabilities as registrationLinkTeamCapabilitiesTable,
  teams as teamsTable,
  users as usersTable,
} from "../db/schema/control-plane";
import { newId, nowIso } from "../ids";
import {
  sha256Hex,
  randomToken,
  encryptSecret,
  decryptSecret,
} from "../crypto";
import {
  passkey as passkeyTable,
  twoFactor as twoFactorTable,
} from "../db/schema/auth";
import {
  assertUser,
  getCurrentUser,
  revokeAllSessions,
  setUserPassword,
} from "../auth";
import { assertPasswordPolicy } from "../password-policy";
import { assertPasswordNotPwned } from "../pwned-password";
import { recordActivity } from "./activity";
import { avatarResolver, avatarUrlFor, teamAvatarUrl } from "../avatar";
import { instanceOwnerUserId } from "./instance-owner";
import {
  isInstanceAdmin,
  requireCapability,
  requireActiveTeamId,
  requireInstanceAdmin,
  membershipFor,
  requireTeamWide,
} from "../membership";
import { accessDelta, cleanCapabilities } from "../membership-shared";
import {
  effectiveRoleCapabilities,
  ensureTeamRoles,
  loadRoleScopes,
  matchTeamRole,
  roleAssignment,
} from "./roles";
import { boundedBy, withView } from "./folder-access";
import { instancePublicBaseUrl } from "./instance-settings";
import type {
  ActivityType,
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
  /**
   * The member's RANK - 'owner' outranks everyone else and is what the guards
   * read. For what to SHOW, use {@link roleName}: two members can both rank as
   * `member` while holding different roles.
   */
  role: Role;
  /** The assigned team role, or null for a hand-picked ("Custom") set. */
  roleId: string | null;
  /** The assigned role's name, or null when the member holds a custom set. */
  roleName: string | null;
  /**
   * Their role reaches only part of the team.
   */
  roleScoped: boolean;
  capabilities: Capability[];
  /**
   * How their access compares with the role they hold: `less` when an admin took
   * something away from this one person, `more` when they were given something
   * extra, `null` when they are exactly their role, which is almost everybody.
   */
  accessDelta: "less" | "more" | null;
  /**
   * True for the team's ABSOLUTE owner - the founder who created the team (the
   * "crown" 👑).
   */
  isPrimaryOwner: boolean;
  /**
   * True if this user is a global instance admin.
   */
  isInstanceAdmin: boolean;
  avatarColor: string;
  /** Resolved picture: uploaded image, else Gravatar, else null for the monogram. */
  avatarUrl: string | null;
  createdAt: string;
}

/** A registered user as shown in the add-member search (username only). */
export interface UserSearchResult {
  userId: string;
  username: string;
  name: string;
  avatarColor: string;
  /** Resolved picture: uploaded image, else Gravatar, else null for the monogram. */
  avatarUrl: string | null;
  /** Their home team's name, to disambiguate identical display names. */
  teamName: string | null;
  /** That team's picture, so the subline reads like every other team mention. */
  teamAvatarUrl: string | null;
}

/** A registered user as shown in the global Users list (no email). */
export interface GlobalUserDTO {
  userId: string;
  username: string;
  name: string;
  avatarColor: string;
  /** Resolved picture: uploaded image, else Gravatar, else null for the monogram. */
  avatarUrl: string | null;
  teamCount: number;
  isInstanceAdmin: boolean;
  /** Owns the instance - their row is closed to every other admin. */
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
  /** Shown ONLY in the admin detail view, never in lists or search. */
  email: string;
  avatarColor: string;
  /** Resolved picture: uploaded image, else Gravatar, else null for the monogram. */
  avatarUrl: string | null;
  isInstanceAdmin: boolean;
  /** Owns the instance - their row is closed to every other admin. */
  isInstanceOwner: boolean;
  suspended: boolean;
  canExposePorts: boolean;
  canMountHostVolumes: boolean;
  /** Drives the admin "Reset two-factor" escape hatch, which is only offered when on. */
  twoFactorEnabled: boolean;
  /** How many passkeys they hold - the twin escape hatch, offered only above zero. */
  passkeyCount: number;
  createdAt: string;
  teams: {
    teamId: string;
    teamName: string;
    teamAvatarUrl: string | null;
    role: Role;
  }[];
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
  /**
   * The link can still be read back with {@link revealRegistrationLink} - it is
   * pending, unexpired, and was minted after the token started being stored
   * encrypted.
   */
  canReveal: boolean;
  /**
   * What to show while the link is covered: the real URL with the token blanked
   * (`https://deplo.example.com/register/••••••••`), so the host still reads at a
   * glance. The token itself is NEVER in this string.
   */
  linkMasked: string;
}

/** Public, display-only view of a registration link for the /register page. */
export interface RegistrationLinkInfo {
  valid: boolean;
  mode: RegistrationMode;
  /** For `existing_teams`: the names of the teams the registrant will join. */
  teamNames: string[];
}

/**
 * The username to attribute an audit entry to.
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
  await requireTeamWide("team members");
  const teamId = await requireActiveTeamId();
  const db = getDb();
  // Self-healing: a team that predates roles (or was created by another path)
  // gets its three defaults here, and the memberships that already match one
  // adopt it, so the list names a real role instead of "Custom" for everyone.
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
    isPrimaryOwner: r.userId === founderId,
    isInstanceAdmin: r.isInstanceAdmin ?? false,
    avatarColor: r.avatarColor,
    avatarUrl: avatarUrl(r),
    createdAt: r.createdAt,
  }));
}

/**
 * Each member's access measured against the role they hold, for the chip on their
 * tile.
 */
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

/** The nodes these people hold grants on inside one team, by user. */
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

/**
 * The user id of a team's founder (absolute owner / "crown"), or null if the team
 * predates the column and was never backfilled, or its founder's account was
 * deleted.
 */
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

/**
 * List registered users available to add to the active team, matching on USERNAME
 * (and display name) only - emails are never searched or returned.
 */
export async function searchUsers(query: string): Promise<UserSearchResult[]> {
  const teamId = await requireActiveTeamId();
  await requireCapability("manage_members");
  const q = query.trim().toLowerCase();
  const db = getDb();
  const admin = await isInstanceAdmin();

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
      // Consumed by `avatarUrl` below and dropped - this DTO carries no email.
      image: usersTable.image,
      email: usersTable.email,
    })
    .from(usersTable)
    .where(notInArray(usersTable.id, inTeam))
    // Most recently created first, so the picker opens on the newest users
    // (the add-member dialog shows ~3 and scrolls for the rest).
    .orderBy(desc(usersTable.createdAt));

  // The actor's own reach: everyone sharing a team with them. One query, and
  // skipped entirely for an admin, who is offered the whole roster.
  let known: Set<string> | null = null;
  if (!admin) {
    const me = await assertUser();
    const myTeams = db
      .select({ teamId: membershipsTable.teamId })
      .from(membershipsTable)
      .where(eq(membershipsTable.userId, me.id));
    known = new Set(
      (
        await db
          .selectDistinct({ userId: membershipsTable.userId })
          .from(membershipsTable)
          .where(inArray(membershipsTable.teamId, myTeams))
      ).map((r) => r.userId),
    );
  }

  const filtered = candidates.filter(
    (u) =>
      // Reachable at all: a colleague, or named exactly. A substring match on a
      // stranger is what turns this into a directory.
      (known === null ||
        known.has(u.id) ||
        (q !== "" && u.username.toLowerCase() === q)) &&
      (!q ||
        u.username.toLowerCase().includes(q) ||
        u.name.toLowerCase().includes(q)),
  );
  if (filtered.length === 0) return [];

  // Home team per candidate = the team they own, else any team they're in.
  const candidateIds = filtered.map((u) => u.id);
  const mine = await db
    .select({
      userId: membershipsTable.userId,
      role: membershipsTable.role,
      teamName: teamsTable.name,
      teamImage: teamsTable.image,
    })
    .from(membershipsTable)
    .innerJoin(teamsTable, eq(teamsTable.id, membershipsTable.teamId))
    .where(inArray(membershipsTable.userId, candidateIds));
  const homeByUser = new Map<string, { name: string; image: string | null }>();
  const ownedSet = new Set<string>();
  for (const m of mine) {
    const home = { name: m.teamName, image: m.teamImage };
    // Prefer the team they own; otherwise keep the first seen.
    if (m.role === "owner" && !ownedSet.has(m.userId)) {
      homeByUser.set(m.userId, home);
      ownedSet.add(m.userId);
    } else if (!homeByUser.has(m.userId)) {
      homeByUser.set(m.userId, home);
    }
  }

  const avatarUrl = await avatarResolver();
  return filtered.map((u) => ({
    userId: u.id,
    username: u.username,
    name: u.name,
    avatarColor: u.avatarColor,
    avatarUrl: avatarUrl({ ...u, userId: u.id }),
    teamName: homeByUser.get(u.id)?.name ?? null,
    teamAvatarUrl: teamAvatarUrl(homeByUser.get(u.id)?.image),
  }));
}

/**
 * What a member assignment resolves to: the rank stamped on the membership row,
 * the role it belongs to (null ⇒ a hand-picked "Custom" set), and the effective
 * capabilities to write.
 */
interface ResolvedAssignment {
  rank: Role;
  roleId: string | null;
  roleName: string | null;
  capabilities: Capability[];
}

/**
 * Resolve either shape of a member assignment: - `roleId` - the current path: the
 * member gets EXACTLY that role's capabilities.
 */
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
  // Granting the `owner` role is escalation - only an existing owner (the founder
  // or an assigned owner) may add another owner. A plain `manage_members` holder
  // can add members/viewers but cannot mint an owner above their own rank.
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
    await actorUsername(),
    null,
    teamId,
    "member_joined",
  );
  return {
    userId: target.id,
    membershipId,
    username: target.username,
    name: target.name,
    avatarUrl: await avatarUrlFor({ ...target, userId: target.id }),
    role: assignment.rank,
    roleId: assignment.roleId,
    roleName: assignment.roleName,
    // A member is only ever ADDED on an existing role, and the card re-reads
    // from `listMembers` on the next render, so the freshly-added row does not
    // have to guess at it.
    roleScoped: false,
    capabilities: caps,
    // Added ON a role, so they are exactly it until somebody says otherwise.
    accessDelta: null,
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

/**
 * Assert that, after the proposed change to `targetUserId`'s membership, the team
 * still has at least one holder of each critical admin capability - under a
 * `SELECT … FOR UPDATE` lock over the holder set so two concurrent demotions
 */
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
  // self-edit that would matter to them is an escalation. Owners keep the
  // legitimate self-edit path (the founder guard below still protects the crown).
  if (input.userId === actingUserId && !actorIsOwner)
    throw new Error("You can't change your own role or permissions");
  const db = getDb();
  await ensureTeamRoles(db, teamId);
  const assignment = await resolveAssignment(db, teamId, input, membership);
  const caps = assignment.capabilities;
  await db.transaction(async (tx) => {
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
    // permissions can't be changed by anyone, including themselves and instance
    // admins, so the creator can never be demoted or locked out of their team.
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
    // Promoting someone to the `owner` role is escalation - only an owner may do
    // it (so a non-owner manager can't mint an owner above their own rank).
    if (assignment.rank === "owner" && !actorIsOwner) {
      throw new Error("Only an owner can grant the owner role.");
    }
    await assertAdminCoverage(tx, teamId, input.userId, caps);
    await tx
      .update(membershipsTable)
      .set({ role: assignment.rank, roleId: assignment.roleId })
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
    await actorUsername(),
    null,
    teamId,
    "member_access_changed",
  );
}

/** The name to put in the trail for a user id, or a neutral stand-in. */
async function usernameOf(userId: string): Promise<string> {
  const rows = await getDb()
    .select({ username: usersTable.username })
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);
  return rows[0]?.username ?? "a member";
}

/** Remove a member from the active team (does not delete their account). */
export async function removeMember(userId: string): Promise<void> {
  const {
    teamId,
    userId: actingUserId,
    membership,
  } = await requireCapability("manage_members");
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
    // The ABSOLUTE owner (founder / "crown") can never be removed by anyone,
    // including instance admins, so the team always keeps its creator.
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
    await tx.delete(membershipsTable).where(eq(membershipsTable.id, m.id));
  });
  await recordActivity(
    "member",
    `Removed ${username || "a member"} from the team`,
    await actorUsername(),
    null,
    teamId,
    "member_removed",
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
      // Consumed by `avatarUrl` below and dropped - this list carries no email.
      image: usersTable.image,
      email: usersTable.email,
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
  const avatarUrl = await avatarResolver();
  return users.map((u) => ({
    userId: u.id,
    username: u.username,
    name: u.name,
    avatarColor: u.avatarColor,
    avatarUrl: avatarUrl({ ...u, userId: u.id }),
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
 * Full detail for one user, for the admin editor: teams & roles, account metadata
 * and the email (admin-only, never in lists/search).
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
      image: usersTable.image,
      isInstanceAdmin: usersTable.isInstanceAdmin,
      suspended: usersTable.suspended,
      canExposePorts: usersTable.canExposePorts,
      canMountHostVolumes: usersTable.canMountHostVolumes,
      twoFactorEnabled: usersTable.twoFactorEnabled,
      createdAt: usersTable.createdAt,
    })
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);
  const u = urows[0];
  if (!u) throw new Error("User not found");
  // Count only, never the rows: an admin needs to know there is something to
  // clear, not what the credentials are.
  const passkeyRows = await db
    .select({ id: passkeyTable.id })
    .from(passkeyTable)
    .where(eq(passkeyTable.userId, userId));
  const teamRows = await db
    .select({
      teamId: membershipsTable.teamId,
      teamName: teamsTable.name,
      teamImage: teamsTable.image,
      role: membershipsTable.role,
    })
    .from(membershipsTable)
    .innerJoin(teamsTable, eq(teamsTable.id, membershipsTable.teamId))
    .where(eq(membershipsTable.userId, userId));
  return {
    userId: u.id,
    username: u.username,
    name: u.name,
    email: u.email,
    avatarColor: u.avatarColor,
    avatarUrl: await avatarUrlFor({ ...u, userId: u.id }),
    isInstanceAdmin: u.isInstanceAdmin ?? false,
    isInstanceOwner: u.id === (await instanceOwnerUserId()),
    suspended: u.suspended ?? false,
    canExposePorts: u.canExposePorts ?? false,
    canMountHostVolumes: u.canMountHostVolumes ?? false,
    twoFactorEnabled: u.twoFactorEnabled ?? false,
    passkeyCount: passkeyRows.length,
    createdAt: u.createdAt,
    teams: teamRows.map((t) => ({
      teamId: t.teamId,
      teamName: t.teamName ?? "(unknown)",
      teamAvatarUrl: teamAvatarUrl(t.teamImage),
      role: t.role as Role,
    })),
  };
}

/**
 * Edit a user's global-scoped attributes: instance-admin flag, suspended status,
 * and an optional admin password reset.
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
  if (newPassword) {
    assertPasswordPolicy(newPassword);
    await assertPasswordNotPwned(newPassword);
  }

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

    // NOBODY edits the owner's row but the owner.
    if (
      ownerUserId !== null &&
      input.userId === ownerUserId &&
      actingUserId !== ownerUserId
    )
      throw new Error(
        "Only the instance owner can edit the instance owner's account",
      );

    // The owner can't uncrown themselves by dropping their own admin flag - the same
    // rule the team founder has (a founder cannot be demoted even by themselves).
    if (input.userId === ownerUserId && !input.isInstanceAdmin)
      throw new Error(
        "The instance owner is always an instance admin. Transfer ownership first.",
      );

    // An admin can't suspend or demote themselves into a lockout corner.
    if (input.userId === actingUserId && input.suspended)
      throw new Error("You can't suspend your own account");

    // Lockout guard: the instance must always retain at least one ACTIVE
    // (non-suspended) instance admin.
    const candidates = await tx
      .select({
        id: usersTable.id,
        isInstanceAdmin: usersTable.isInstanceAdmin,
        suspended: usersTable.suspended,
      })
      .from(usersTable)
      .where(
        or(
          eq(usersTable.isInstanceAdmin, true),
          eq(usersTable.id, input.userId),
        ),
      )
      .for("update");
    const activeAdminsAfter = candidates.filter((x) => {
      const isAdmin =
        x.id === target.id
          ? input.isInstanceAdmin
          : (x.isInstanceAdmin ?? false);
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
      })
      .where(eq(usersTable.id, input.userId));
    // The credential lives on the Better Auth `account` row since 0055, so a
    // reset writes there - in the same transaction, so a failed lockout check
    // rolls the new password back with everything else.
    if (newPassword) await setUserPassword(input.userId, newPassword, tx);
  });

  // An admin password reset also revokes the target's outstanding sessions: they no
  // longer control the credential, so any live cookie of theirs must die.
  if (newPassword) await revokeAllSessions(input.userId);

  const target = (
    await getDb()
      .select({ username: usersTable.username })
      .from(usersTable)
      .where(eq(usersTable.id, input.userId))
      .limit(1)
  )[0]!;
  await recordForEveryTeamOf(
    "member",
    input.userId,
    `Updated user @${target.username}` +
      (newPassword ? " (password reset)" : ""),
  );
}

/**
 * The trail for an INSTANCE-wide action on one account. It belongs to every team
 * that account is a member of, once each; an account in no team writes nothing,
 * because there is no trail it belongs in.
 */
async function recordForEveryTeamOf(
  type: ActivityType,
  userId: string,
  message: string,
): Promise<void> {
  const rows = await getDb()
    .selectDistinct({ teamId: membershipsTable.teamId })
    .from(membershipsTable)
    .where(eq(membershipsTable.userId, userId));
  const actor = await actorUsername();
  for (const { teamId } of rows)
    await recordActivity(
      type,
      message,
      actor,
      null,
      teamId,
      "member_access_changed",
    );
}

/**
 * Clear a user's two-factor enrolment. The backstop for the one thing requiring a
 * code to turn 2FA off takes away: before it, someone who lost their phone could
 * still disable 2FA with their password, and now they cannot.
 */
export async function resetUserTwoFactor(userId: string): Promise<void> {
  const { userId: actingUserId } = await requireInstanceAdmin();
  // Never your own. Not a courtesy rule: this path asks for no code, so a self-reset
  // would be the password-only disable that lib/data/two-factor.ts exists to forbid,
  // reopened for anyone with the admin flag.
  // ponytail: an instance whose ONLY admin loses both their phone and all ten
  // recovery codes has no way back in short of the database. Recovery codes are
  // downloadable at enrolment and the disable path accepts one, so a break-glass
  // is not worth building until someone actually gets stuck.
  if (userId === actingUserId)
    throw new Error(
      "You can't reset your own two-factor here. Turn it off from Settings → Security, which asks for a code.",
    );
  const ownerUserId = await instanceOwnerUserId();
  if (
    ownerUserId !== null &&
    userId === ownerUserId &&
    actingUserId !== ownerUserId
  )
    throw new Error(
      "Only the instance owner can edit the instance owner's account",
    );
  const target = (
    await getDb()
      .select({
        username: usersTable.username,
        enabled: usersTable.twoFactorEnabled,
      })
      .from(usersTable)
      .where(eq(usersTable.id, userId))
      .limit(1)
  )[0];
  if (!target) throw new Error("User not found");
  if (!target.enabled)
    throw new Error("That account does not have two-factor authentication on");

  await getDb().transaction(async (tx) => {
    await tx
      .update(usersTable)
      .set({ twoFactorEnabled: false })
      .where(eq(usersTable.id, userId));
    await tx.delete(twoFactorTable).where(eq(twoFactorTable.userId, userId));
  });

  await recordForEveryTeamOf(
    "security",
    userId,
    `Reset two-factor authentication for @${target.username}`,
  );
}

/**
 * Remove every passkey from a user's account.
 */
export async function resetUserPasskeys(userId: string): Promise<void> {
  const { userId: actingUserId } = await requireInstanceAdmin();
  // Your own are removable from Settings → Security, which asks for the
  // password. Allowing it here would be that same removal with no password.
  if (userId === actingUserId)
    throw new Error(
      "You can't remove your own passkeys here. Do it from Settings → Security, which asks for your password.",
    );
  const ownerUserId = await instanceOwnerUserId();
  if (
    ownerUserId !== null &&
    userId === ownerUserId &&
    actingUserId !== ownerUserId
  )
    throw new Error(
      "Only the instance owner can edit the instance owner's account",
    );
  const target = (
    await getDb()
      .select({ username: usersTable.username })
      .from(usersTable)
      .where(eq(usersTable.id, userId))
      .limit(1)
  )[0];
  if (!target) throw new Error("User not found");

  const removed = await getDb()
    .delete(passkeyTable)
    .where(eq(passkeyTable.userId, userId))
    .returning({ id: passkeyTable.id });
  if (removed.length === 0) throw new Error("That account has no passkeys");

  await recordForEveryTeamOf(
    "security",
    userId,
    removed.length === 1
      ? `Removed @${target.username}'s passkey`
      : `Removed @${target.username}'s ${removed.length} passkeys`,
  );
}

/* ------------------------------------------------------------------ */
/* Registration links (new global accounts + own team)                */
/* ------------------------------------------------------------------ */

export interface MintRegistrationResult {
  /** Absolute /register/<token> URL, always returned for copying/sharing. */
  link: string;
}

const MAX_REGISTRATION_TEAMS = 50;

/**
 * Mint a single-use registration link. The choice is baked into the link via its
 * `mode` + `registration_link_teams` rows and cannot be changed by the registrant.
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
    // Kept beside the hash so the admin can copy the link again for the 24 hours
    // it lives - see `revealRegistrationLink`. The hash stays the lookup key.
    tokenEnc: encryptSecret(rawToken),
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
    // A new user joins existing teams as member/viewer ONLY, never as an owner.
    for (const a of assignments) {
      if (a.role !== "member" && a.role !== "viewer")
        throw new Error(
          "A new user can only join a team as a member or viewer",
        );
    }
    // The minting admin may only place a new user into teams THEY belong to - an
    // instance admin is NOT implicitly a member of every team.
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

  const base = await instancePublicBaseUrl();
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
      // Presence only - the ciphertext never leaves this function.
      tokenEnc: registrationLinksTable.tokenEnc,
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
      .innerJoin(
        teamsTable,
        eq(teamsTable.id, registrationLinkTeamsTable.teamId),
      )
      .where(inArray(registrationLinkTeamsTable.linkId, linkIds))
      .orderBy(asc(teamsTable.name));
    for (const r of teamRows) {
      const list = namesByLink.get(r.linkId) ?? [];
      list.push(r.name);
      namesByLink.set(r.linkId, list);
    }
  }

  const maskedBase = `${await publicBaseUrl()}/register/`;
  const now = Date.now();
  return rows.map((l) => ({
    id: l.id,
    status: l.status as RegistrationLink["status"],
    mode: l.mode as RegistrationMode,
    teamNames: namesByLink.get(l.id) ?? [],
    createdBy: l.createdBy,
    usedByUsername: l.usedByUsername,
    expiresAt: l.expiresAt,
    createdAt: l.createdAt,
    canReveal:
      !!l.tokenEnc && l.status === "pending" && Date.parse(l.expiresAt) > now,
    linkMasked: `${maskedBase}${"•".repeat(12)}`,
  }));
}

/**
 * The public base URL, or "" when there is no request to read it from (the
 * scheduler, a test). Only ever used for DISPLAY here - a mint that needs a real
 * URL still lets the failure through.
 */
async function publicBaseUrl(): Promise<string> {
  try {
    return await instancePublicBaseUrl();
  } catch {
    return "";
  }
}

/**
 * Read a pending registration link back, in full, so the admin who minted it can
 * hand it over again - the alternative was minting a second link because the first
 * one got lost between the clipboard and the chat window.
 */
export async function revealRegistrationLink(id: string): Promise<string> {
  await requireInstanceAdmin();
  const [row] = await getDb()
    .select()
    .from(registrationLinksTable)
    .where(eq(registrationLinksTable.id, id))
    .limit(1);
  if (!row) throw new Error("Link not found");
  if (row.status === "used")
    throw new Error(
      `This link was already used${row.usedByUsername ? ` by @${row.usedByUsername}` : ""} - registration links work once. Mint a new one.`,
    );
  if (row.status !== "pending")
    throw new Error("This link was revoked. Mint a new one.");
  if (Date.parse(row.expiresAt) <= Date.now())
    throw new Error("This link has expired. Mint a new one.");
  if (!row.tokenEnc)
    throw new Error(
      "This link was created before links could be shown again. Revoke it and mint a new one.",
    );
  const rawToken = decryptSecret(row.tokenEnc);
  // Fails closed to "" (a rotated DEPLO_SECRET), and a half-URL is worse than a
  // clear error - the admin can always mint a fresh link.
  if (rawToken === "")
    throw new Error(
      "This link could not be decrypted. Revoke it and mint a new one.",
    );
  return `${await instancePublicBaseUrl()}/register/${rawToken}`;
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
export async function isRegistrationTokenValid(
  rawToken: string,
): Promise<boolean> {
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
 * registrant will join.
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
 * The per-team role + capability assignments baked into a pending `existing_teams`
 * link, resolved against teams that still exist.
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
 * one atomic critical section (relational-store PLAN §1/§3).
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
