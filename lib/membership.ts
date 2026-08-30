import "server-only";

import { cache } from "react";
import { cookies } from "next/headers";
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "./db/client";
import { holdsAPasskey, passkeyCountsForThisRequest } from "./passkey-policy";
import { teamAvatarUrl } from "./avatar";
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
  teams as teamsTable,
  users as usersTable,
} from "./db/schema/control-plane";
import { assertUser, getCurrentUser } from "./auth";
import {
  ALL_CAPABILITIES,
  type Capability,
  type Membership,
  type Team,
} from "./types";
import {
  CAPABILITY_META,
  PROJECT_SCOPED_CAPABILITIES,
  boundedBy,
} from "./membership-shared";
import { currentIdentity, narrowedScope } from "./auth/request-context";
import { requestIsHttps } from "./public-url";
// The leaf module: a role's reach, with no dependency back on this one.
import { memberScopeFor, type NodeScope } from "./data/node-scope";

export {
  CAPABILITY_PRESETS,
  CAPABILITY_META,
  capabilitiesForRole,
  roleLabelForCapabilities,
} from "./membership-shared";

/**
 * Active-team context for the multi-tenant control plane. Data functions call
 * `getActiveTeamId()` internally and filter their reads/writes by it; mutating
 * actions call `requireCapability(...)` to gate on the member's permissions.
 */

const ACTIVE_TEAM_COOKIE = "deplo_team";
const ACTIVE_TEAM_TTL_SECONDS = 60 * 60 * 24 * 365; // 1 year

/**
 * Reassemble the `capabilities` array for a set of memberships from the junction
 * in ONE query (batch-load, never per-membership - relational-store PLAN §6
 * "N+1 on capabilities"). Returns a map of membershipId → capabilities.
 */
async function capabilitiesByMembership(
  membershipIds: string[],
): Promise<Map<string, Capability[]>> {
  const byId = new Map<string, Capability[]>();
  if (membershipIds.length === 0) return byId;
  const rows = await getDb()
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

/** All teams the given user is a member of, in creation order. */
export async function teamsForUser(userId: string): Promise<Team[]> {
  const rows = await getDb()
    .select({
      id: teamsTable.id,
      name: teamsTable.name,
      slug: teamsTable.slug,
      plan: teamsTable.plan,
      founderUserId: teamsTable.founderUserId,
      image: teamsTable.image,
      createdAt: teamsTable.createdAt,
    })
    .from(teamsTable)
    .innerJoin(membershipsTable, eq(membershipsTable.teamId, teamsTable.id))
    .where(eq(membershipsTable.userId, userId))
    .orderBy(teamsTable.createdAt);
  return rows.map((t) => ({
    id: t.id,
    name: t.name,
    slug: t.slug,
    plan: t.plan as Team["plan"],
    founderUserId: t.founderUserId ?? null,
    avatarUrl: teamAvatarUrl(t.image),
    createdAt: t.createdAt,
  }));
}

/* ------------------------------------------------------------------ */
/* Two-factor policy                                                   */
/* ------------------------------------------------------------------ */

/**
 * Thrown when a team (or the member's role in it) requires two-factor
 * authentication and the account has not enrolled one.
 */
export class TwoFactorRequiredError extends Error {
  constructor(
    readonly teamId: string,
    readonly reason: string,
  ) {
    super(
      `${reason} requires two-factor authentication. Turn it on in Settings → Security to continue.`,
    );
    this.name = "TwoFactorRequiredError";
  }
}

/**
 * Whether `userId` satisfies `teamId`'s 2FA policy, and if not, what to name.
 * Request-cached: the gate runs on every read AND every capability check, so
 * without memoization a single page would re-run it dozens of times.
 */
const twoFactorMandate = cache(
  async (
    userId: string,
    teamId: string,
  ): Promise<{ satisfied: boolean; reason: string }> => {
    const rows = await getDb()
      .select({
        enrolled: usersTable.twoFactorEnabled,
        hasPasskey: holdsAPasskey(usersTable.id),
        teamRequires: teamsTable.requireTwoFactor,
        teamName: teamsTable.name,
        roleRequires: teamRolesTable.requireTwoFactor,
        roleName: teamRolesTable.name,
      })
      .from(membershipsTable)
      .innerJoin(usersTable, eq(usersTable.id, membershipsTable.userId))
      .innerJoin(teamsTable, eq(teamsTable.id, membershipsTable.teamId))
      .leftJoin(teamRolesTable, eq(teamRolesTable.id, membershipsTable.roleId))
      .where(
        and(
          eq(membershipsTable.userId, userId),
          eq(membershipsTable.teamId, teamId),
        ),
      )
      .limit(1);
    const r = rows[0];
    // No membership: not this gate's problem. The caller's own "not a member"
    // handling is the right answer, and inventing a 2FA error here would be a
    // confusing way to say "you were removed from this team".
    if (!r) return { satisfied: true, reason: "" };
    if (r.enrolled) return { satisfied: true, reason: "" };
    // Two questions, never one: the account holds a usable passkey, AND this
    // request is one the passkey actually opened. See lib/passkey-policy.ts.
    if (r.hasPasskey && (await passkeyCountsForThisRequest()))
      return { satisfied: true, reason: "" };
    if (r.roleRequires)
      return { satisfied: false, reason: `The ${r.roleName} role` };
    if (r.teamRequires) return { satisfied: false, reason: r.teamName };
    return { satisfied: true, reason: "" };
  },
);

/** Throw if `userId` is under an unmet 2FA policy in `teamId`. */
async function assertTwoFactor(userId: string, teamId: string): Promise<void> {
  const { satisfied, reason } = await twoFactorMandate(userId, teamId);
  if (!satisfied) throw new TwoFactorRequiredError(teamId, reason);
}

/**
 * The policy blocking (or that would block) the CURRENT user, across every team
 * they belong to - what Settings → Security needs to explain why 2FA cannot be
 * turned off. Returns null when nothing requires it.
 */
export async function twoFactorMandateForCurrentUser(): Promise<string | null> {
  const user = await getCurrentUser();
  if (!user) return null;
  const rows = await getDb()
    .select({
      teamRequires: teamsTable.requireTwoFactor,
      teamName: teamsTable.name,
      roleRequires: teamRolesTable.requireTwoFactor,
      roleName: teamRolesTable.name,
    })
    .from(membershipsTable)
    .innerJoin(teamsTable, eq(teamsTable.id, membershipsTable.teamId))
    .leftJoin(teamRolesTable, eq(teamRolesTable.id, membershipsTable.roleId))
    .where(eq(membershipsTable.userId, user.id));
  for (const r of rows) {
    if (r.roleRequires) return `The ${r.roleName} role in ${r.teamName}`;
    if (r.teamRequires) return r.teamName;
  }
  return null;
}

/** The user's membership in a specific team (with capabilities), or null. */
export async function membershipFor(
  userId: string,
  teamId: string,
): Promise<Membership | null> {
  // THE gate.
  await assertTwoFactor(userId, teamId);
  const rows = await getDb()
    .select({
      id: membershipsTable.id,
      userId: membershipsTable.userId,
      teamId: membershipsTable.teamId,
      role: membershipsTable.role,
      createdAt: membershipsTable.createdAt,
    })
    .from(membershipsTable)
    .where(
      and(
        eq(membershipsTable.userId, userId),
        eq(membershipsTable.teamId, teamId),
      ),
    )
    .limit(1);
  const m = rows[0];
  if (!m) return null;
  const caps = (await capabilitiesByMembership([m.id])).get(m.id) ?? [];
  return {
    id: m.id,
    userId: m.userId,
    teamId: m.teamId,
    role: m.role as Membership["role"],
    capabilities: clampToToken(caps, userId, teamId),
    createdAt: m.createdAt,
  };
}

/**
 * Narrow a member's effective capabilities to what the API token making this
 * request was granted.
 */
function clampToToken(
  caps: Capability[],
  userId: string,
  teamId: string,
): Capability[] {
  const id = currentIdentity();
  if (!id?.token || id.userId !== userId || id.teamId !== teamId) return caps;
  const own = boundedBy(caps, id.token.capabilities);
  // Depth strips, breadth doesn't: a token holding this team WHOLLY keeps every
  // capability it was given, however many other teams it also reaches.
  return narrowedScope() ? boundedBy(own, PROJECT_SCOPED_CAPABILITIES) : own;
}

/** {@link clampToToken}, for the node-level resolver that bypasses `membershipFor`. */
export const clampCapabilitiesToToken = clampToToken;

/**
 * Resolve the active team id for the current request. Reads the `deplo_team`
 * cookie, validates it against the user's memberships, and falls back to the
 * user's first team.
 */
export const getActiveTeamId = cache(async (): Promise<string | null> => {
  const user = await getCurrentUser();
  if (!user) return null;
  const teams = await teamsForUser(user.id);
  if (teams.length === 0) return null;
  // A bearer-token request is scoped to the token's team, and ONLY that team.
  const override = currentIdentity();
  if (override) {
    if (!teams.some((t) => t.id === override.teamId))
      throw new Error(
        "This request is scoped to a team the user no longer belongs to.",
      );
    return override.teamId;
  }
  const store = await cookies();
  const cookieTeam = store.get(ACTIVE_TEAM_COOKIE)?.value;
  if (cookieTeam && teams.some((t) => t.id === cookieTeam)) return cookieTeam;
  return teams[0].id;
});

/**
 * The active team id, throwing if the user is not a member of any team.
 * The canonical entry point for the data layer's team scoping.
 */
export async function requireActiveTeamId(): Promise<string> {
  const teamId = await getActiveTeamId();
  if (!teamId) throw new Error("No active team");
  // The twin of the guard in `membershipFor`.
  const user = await getCurrentUser();
  if (user) await assertTwoFactor(user.id, teamId);
  return teamId;
}

export interface ActiveMembership {
  userId: string;
  teamId: string;
  membership: Membership;
}

/** The current user's membership in the active team, throwing if absent. */
export async function requireMembership(): Promise<ActiveMembership> {
  const user = await assertUser();
  const teamId = await requireActiveTeamId();
  const membership = await membershipFor(user.id, teamId);
  if (!membership) throw new Error("Not a member of this team");
  return { userId: user.id, teamId, membership };
}

/** True if the current user has the given capability in the active team. */
export async function hasCapability(cap: Capability): Promise<boolean> {
  const user = await getCurrentUser();
  if (!user) return false;
  const teamId = await getActiveTeamId();
  if (!teamId) return false;
  const m = await membershipFor(user.id, teamId);
  return Boolean(m && m.capabilities.includes(cap));
}

/**
 * The current user's effective capabilities in the active team (empty if none).
 * Drives capability-gated nav visibility in the shell.
 */
export async function currentCapabilities(): Promise<Capability[]> {
  const user = await getCurrentUser();
  if (!user) return [];
  const teamId = await getActiveTeamId();
  if (!teamId) return [];
  return (await membershipFor(user.id, teamId))?.capabilities ?? [];
}

/**
 * Everything the current user could do SOMEWHERE in the active team: their role's
 * set, plus every capability any node grant hands them (ADR-0016).
 */
export async function reachableCapabilities(): Promise<Capability[]> {
  const user = await getCurrentUser();
  if (!user) return [];
  const teamId = await getActiveTeamId();
  if (!teamId) return [];
  const own = (await membershipFor(user.id, teamId))?.capabilities ?? [];
  if (own.length === 0) return [];

  const db = getDb();
  const [fromApps, fromFolders, fromProjects] = await Promise.all([
    db
      .selectDistinct({ capability: appGrantsTable.capability })
      .from(appGrantsTable)
      .innerJoin(appsTable, eq(appsTable.id, appGrantsTable.appId))
      .where(
        and(eq(appGrantsTable.userId, user.id), eq(appsTable.teamId, teamId)),
      ),
    db
      .selectDistinct({ capability: folderGrantsTable.capability })
      .from(folderGrantsTable)
      .innerJoin(foldersTable, eq(foldersTable.id, folderGrantsTable.folderId))
      .where(
        and(
          eq(folderGrantsTable.userId, user.id),
          eq(foldersTable.teamId, teamId),
        ),
      ),
    db
      .selectDistinct({ capability: projectGrantsTable.capability })
      .from(projectGrantsTable)
      .innerJoin(
        projectsTable,
        eq(projectsTable.id, projectGrantsTable.projectId),
      )
      .where(
        and(
          eq(projectGrantsTable.userId, user.id),
          eq(projectsTable.teamId, teamId),
        ),
      ),
  ]);
  const granted = [...fromApps, ...fromFolders, ...fromProjects].map(
    (r) => r.capability as Capability,
  );
  if (granted.length === 0) return own;
  // A grant bypasses `membershipFor`, so the token clamp has to be applied here
  // too - the same reason `lib/data/node-access.ts` ends with it.
  const union = new Set<Capability>([
    ...own,
    ...clampToToken(granted, user.id, teamId),
  ]);
  return ALL_CAPABILITIES.filter((c) => union.has(c));
}

/** True if the user holds `cap` anywhere in the active team. See the caveat above. */
export async function hasCapabilityAnywhere(cap: Capability): Promise<boolean> {
  return (await reachableCapabilities()).includes(cap);
}

/**
 * Authorize a mutating action: assert the user is a member of the active team
 * AND holds `cap`. Returns the active membership so callers can read the user.
 * Throws a user-facing "Unauthorized" - caught by the action `run()` wrapper.
 */
export async function requireCapability(
  cap: Capability,
): Promise<ActiveMembership> {
  const ctx = await requireMembership();
  if (!ctx.membership.capabilities.includes(cap)) {
    throw new Error(
      `You don't have permission to ${CAPABILITY_META[cap].label.toLowerCase()}`,
    );
  }
  return ctx;
}

/* ------------------------------------------------------------------ */
/* Instance-admin (global scope)                                       */
/* ------------------------------------------------------------------ */

/**
 * True if the current user is a global instance admin - the gate for the
 * Settings → Users list, minting registration links, and the per-user admin
 * editor. Orthogonal to per-team capabilities.
 */
export async function isInstanceAdmin(): Promise<boolean> {
  const user = await getCurrentUser();
  if (!user?.isInstanceAdmin) return false;
  return tokenHoldsInstanceAdmin();
}

/** Throwing variant for admin-only data functions / actions. */
export async function requireInstanceAdmin(): Promise<{ userId: string }> {
  const user = await assertUser();
  if (!user.isInstanceAdmin || !tokenHoldsInstanceAdmin())
    // Generic on purpose: this gates every instance-admin action (users, teams,
    // global env, servers), not just user management.
    throw new Error("Only an instance admin can do that");
  return { userId: user.id };
}

/**
 * Instance-admin is opt-in PER TOKEN, not inherited from the person.
 */
function tokenHoldsInstanceAdmin(): boolean {
  const token = currentIdentity()?.token;
  return !token || token.instanceAdmin;
}

/**
 * Refuse a resource that has no per-Project meaning to a principal who reaches
 * only part of this team - a narrowed API token, or a member whose ROLE is scoped.
 */
export async function requireTeamWide(what: string): Promise<void> {
  if (narrowedScope())
    throw new Error(
      `This API token is limited to specific projects and can't access ${what}.`,
    );
  if (!(await reachesWholeTeam()))
    throw new Error(
      `Your role only reaches part of this team, so it can't access ${what}.`,
    );
}

/**
 * Does the current principal hold `cap` across the WHOLE of `teamId` - a team that
 * is NOT necessarily the active one? The question a cross-team share has to ask of
 * every team it is offered to (ADR-0027).
 *
 * Four gates, all load-bearing, and `membershipFor` answers only the last two:
 * `clampToToken` deliberately bails out for a team other than the request's, so it
 * would hand back the MEMBER's capabilities and ignore the token's entirely.
 */
export async function holdsTeamWideCapability(
  teamId: string,
  cap: Capability,
): Promise<boolean> {
  const user = await getCurrentUser();
  if (!user) return false;
  const token = currentIdentity()?.token;
  if (token) {
    if (!token.capabilities.includes(cap)) return false;
    // Breadth, not depth: a token reaching this team through ONE project does not
    // hold it, and `scope.teamIds` cannot tell the two apart.
    if (token.scope && !token.scope.wholeTeamIds.includes(teamId)) return false;
  }
  // A role scoped to a folder or a project inside that team is not team-wide there.
  if ((await memberScopeFor(user.id, teamId)) != null) return false;
  try {
    const m = await membershipFor(user.id, teamId);
    return Boolean(m?.capabilities.includes(cap));
  } catch {
    // Not a member, or an unmet 2FA mandate in that team: either way, no.
    return false;
  }
}

/**
 * The CURRENT caller's reach in the active team, or null when they reach all of it -
 * their own nodes when their membership carries a set, their role's scope
 * otherwise ({@link memberScopeFor}).
 */
export async function currentMemberScope(): Promise<NodeScope | null> {
  const user = await getCurrentUser();
  if (!user) return null;
  const teamId = await getActiveTeamId();
  if (!teamId) return null;
  // An instance admin is not a member acting under a team role.
  if (await isInstanceAdmin()) return null;
  return memberScopeFor(user.id, teamId);
}

/**
 * The non-throwing twin of {@link requireTeamWide}, for a PAGE that has to degrade
 * rather than fail: a section outside someone's access should say so, not render
 * the error boundary over a healthy dashboard.
 */
export async function reachesWholeTeam(): Promise<boolean> {
  if (narrowedScope()) return false;
  const user = await getCurrentUser();
  // FAIL CLOSED. Every caller today happens to prove a session first, so this changes
  // nothing about who can do what; it is the default being right that matters,
  // because the next caller will not check.
  if (!user) return false;
  const teamId = await getActiveTeamId();
  if (!teamId) return false;
  return (await memberScopeFor(user.id, teamId)) == null;
}

/* ------------------------------------------------------------------ */
/* Instance-wide grants (global scope, orthogonal to teams)            */
/* ------------------------------------------------------------------ */

/**
 * The two grant flags don't ride on {@link PublicUser} (they're server-enforced
 * only), so resolve them from the raw stored user. Instance admins hold every
 * grant implicitly. Returns `false` for an unauthenticated caller.
 */
async function hasGrant(
  user: { id: string } | null,
  flag: "canExposePorts" | "canMountHostVolumes",
): Promise<boolean> {
  if (!user) return false;
  const rows = await getDb()
    .select({
      isInstanceAdmin: usersTable.isInstanceAdmin,
      canExposePorts: usersTable.canExposePorts,
      canMountHostVolumes: usersTable.canMountHostVolumes,
    })
    .from(usersTable)
    .where(eq(usersTable.id, user.id))
    .limit(1);
  const raw = rows[0];
  return Boolean(raw && (raw.isInstanceAdmin || raw[flag]));
}

/**
 * True if the current user may publish container ports - a compose service's
 * `ports:` (bound to the host) or `expose:` (advertised to linked containers).
 */
export async function canExposePorts(): Promise<boolean> {
  return hasGrant(await getCurrentUser(), "canExposePorts");
}

/** Throwing variant - gate any action that publishes container ports. */
export async function requireExposePorts(): Promise<{ userId: string }> {
  const user = await assertUser();
  if (!(await hasGrant(user, "canExposePorts")))
    throw new Error("You don't have permission to publish ports");
  return { userId: user.id };
}

/** True if the current user may bind-mount a host filesystem path. */
export async function canMountHostVolumes(): Promise<boolean> {
  return hasGrant(await getCurrentUser(), "canMountHostVolumes");
}

/**
 * Whether a NAMED user still holds the host grant - what a deploy asks about the
 * person who authored a compose that reaches the server, since a deploy has no
 * current user of its own (a push webhook has nobody at all).
 */
export async function userMayReachHost(userId: string): Promise<boolean> {
  return hasGrant({ id: userId }, "canMountHostVolumes");
}

/** Throwing variant - gate any host bind mount behind this. */
export async function requireMountHostVolumes(
  /** What asked for it, when it was not a Bind. See `composeHostReach`. */
  reach?: string,
): Promise<{ userId: string }> {
  const user = await assertUser();
  if (!(await hasGrant(user, "canMountHostVolumes")))
    throw new Error(
      reach
        ? `You don't have permission to let an app reach the server, and this one uses ${reach}. An admin turns it on with "Bind server folders" in Settings -> Users.`
        : "You don't have permission to add a Bind (a folder on the server)",
    );
  return { userId: user.id };
}

/** Set the active-team cookie. Validates membership before writing. */
export async function setActiveTeam(teamId: string): Promise<void> {
  const user = await assertUser();
  if (!(await membershipFor(user.id, teamId))) {
    throw new Error("Not a member of this team");
  }
  const store = await cookies();
  store.set(ACTIVE_TEAM_COOKIE, teamId, {
    httpOnly: true,
    // Per REQUEST, not per instance: see requestIsHttps. A `Secure` cookie
    // written on the panel's plain-http IP address is one the browser drops.
    secure: await requestIsHttps(),
    sameSite: "lax",
    path: "/",
    maxAge: ACTIVE_TEAM_TTL_SECONDS,
  });
}

export { ACTIVE_TEAM_COOKIE };
