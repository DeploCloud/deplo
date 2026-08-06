import "server-only";

import { cache } from "react";
import { cookies } from "next/headers";
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "./db/client";
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
import { ALL_CAPABILITIES, type Capability, type Membership, type Team } from "./types";
import {
  CAPABILITY_META,
  PROJECT_SCOPED_CAPABILITIES,
  boundedBy,
} from "./membership-shared";
import { currentIdentity, narrowedScope } from "./auth/request-context";
// The leaf module: a role's reach, with no dependency back on this one.
import { roleScopeFor } from "./data/node-scope";

export {
  CAPABILITY_PRESETS,
  CAPABILITY_META,
  capabilitiesForRole,
  roleLabelForCapabilities,
} from "./membership-shared";

/**
 * Active-team context for the multi-tenant control plane.
 *
 * Mirrors how `getCurrentUser()` works: instead of threading `teamId` through
 * every data-layer signature, the active team is resolved once per request from
 * a signed-by-membership cookie and cached. Data functions call
 * `getActiveTeamId()` internally and filter their reads/writes by it; mutating
 * actions call `requireCapability(...)` to gate on the member's permissions.
 *
 * Identity (`users`/`teams`/`memberships`) is relational (relational-store PLAN
 * cut-set (b)). `teamsForUser`/`membershipFor`/`hasGrant` query Postgres via
 * `getDb()` and are therefore **async** — every caller awaits them. A
 * `Membership.capabilities` array is reassembled from the
 * `membership_capabilities` junction on read.
 */

const ACTIVE_TEAM_COOKIE = "deplo_team";
const ACTIVE_TEAM_TTL_SECONDS = 60 * 60 * 24 * 365; // 1 year

/**
 * Reassemble the `capabilities` array for a set of memberships from the junction
 * in ONE query (batch-load, never per-membership — relational-store PLAN §6
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
      createdAt: teamsTable.createdAt,
    })
    .from(teamsTable)
    .innerJoin(
      membershipsTable,
      eq(membershipsTable.teamId, teamsTable.id),
    )
    .where(eq(membershipsTable.userId, userId))
    .orderBy(teamsTable.createdAt);
  return rows.map((t) => ({
    id: t.id,
    name: t.name,
    slug: t.slug,
    plan: t.plan as Team["plan"],
    founderUserId: t.founderUserId ?? null,
    createdAt: t.createdAt,
  }));
}

/* ------------------------------------------------------------------ */
/* Two-factor policy                                                   */
/* ------------------------------------------------------------------ */

/**
 * Thrown when a team (or the member's role in it) requires two-factor
 * authentication and the account has not enrolled one. Carries the team id and a
 * human reason so the caller can say WHICH policy is blocking them.
 *
 * This is a hard stop, not a downgrade: a member under an unmet 2FA policy gets
 * NO capabilities, no reads, and no bearer-API access in that team — "niente 2FA,
 * niente di niente". Their other teams are untouched, and their own account
 * settings stay reachable, which is what makes the block recoverable.
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
 *
 * Two independent sources, either of which is enough: the team-wide switch
 * (`teams.require_two_factor`) and the member's own role
 * (`team_roles.require_two_factor`). A membership with no role — the hand-picked
 * "Custom" capability set — is covered by the team switch alone.
 *
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
 * they belong to — what Settings → Security needs to explain why 2FA cannot be
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
  // THE gate. Everything that resolves what a member may do runs through here —
  // requireMembership, requireCapability, hasCapability, currentCapabilities, and
  // authenticateToken for the bearer API — so one guard closes the UI and the API
  // together. Reads go through requireActiveTeamId, which carries the twin call.
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
 * request was granted. THE clamp: because every authorization decision — the
 * mutation gates, the nav, `ctx.capabilities`, the per-folder maths — reads
 * `membershipFor`, one intersection here is what makes a token a principal with
 * its own permissions instead of an impersonation of its creator.
 *
 * Two intersections, in order:
 *  - the token's own set, so it can never exceed its creator (and loses a
 *    permission the moment they do — nothing is materialized, this is read live);
 *  - and, when the token is narrowed BELOW this whole team (to a project or a
 *    single app), {@link PROJECT_SCOPED_CAPABILITIES}, which drops every
 *    team-wide permission that has no per-project meaning. Naming several whole
 *    teams is breadth and strips nothing.
 *
 * Keyed on the (userId, teamId) PAIR because `membershipFor` is also called to
 * hydrate OTHER people's memberships (the member list, the roles page, a folder
 * grant's bound) — clamping those would make a token see the rest of the team
 * through its own permissions. A cookie request carries no token and is untouched.
 *
 * Exported as {@link clampCapabilitiesToToken} because a node grant (ADR-0016)
 * REPLACES the membership set rather than narrowing it, so it never passes
 * through the intersection below — `lib/data/node-access.ts` has to apply the
 * same clamp itself or a scoped CI token would inherit its creator's grants.
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
  // capability it was given, however many other teams it also reaches. Only
  // being narrowed to a project or an app inside this team drops the team-wide
  // ones, which have no per-project meaning.
  return narrowedScope() ? boundedBy(own, PROJECT_SCOPED_CAPABILITIES) : own;
}

/** {@link clampToToken}, for the node-level resolver that bypasses `membershipFor`. */
export const clampCapabilitiesToToken = clampToToken;

/**
 * Resolve the active team id for the current request. Reads the `deplo_team`
 * cookie, validates it against the user's memberships, and falls back to the
 * user's first team. Returns null when unauthenticated or the user has no team.
 * Cached per-request so it is cheap to call from many data functions.
 */
export const getActiveTeamId = cache(async (): Promise<string | null> => {
  const user = await getCurrentUser();
  if (!user) return null;
  const teams = await teamsForUser(user.id);
  if (teams.length === 0) return null;
  // A bearer-token request is scoped to the token's team — and ONLY that team.
  // If the principal no longer belongs to it (a stale token), fail CLOSED with a
  // clear error: the request must never silently re-scope to another of their
  // teams (the old teams[0] fallback). authenticateToken already rejects such a
  // token upstream, so in the live GraphQL path this branch only ever sees a
  // valid membership; the throw is the defense-in-depth backstop for a stale
  // identity reaching the data layer directly.
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
  // The twin of the guard in `membershipFor`. Every READ in lib/data scopes
  // itself through this function and never touches `membershipFor`, so without
  // this second call a member under an unmet 2FA policy would still be able to
  // list apps, logs and variables — blocked from writing, but not from looking.
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
 *
 * This is deliberately WIDER than the truth at any one place, and it must only be
 * used where being wider is the correct answer — showing a nav item or a tab that
 * is useful for at least one app, and the GraphQL `authScopes` pre-check, which
 * `lib/graphql/context.ts` has always documented as a convenience snapshot rather
 * than the boundary. The boundary is `requireAppCapability`, which asks about one
 * specific app and is the only thing that may decide a mutation.
 *
 * Three cheap DISTINCT lookups, each already narrowed to this user and team.
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
      .where(and(eq(appGrantsTable.userId, user.id), eq(appsTable.teamId, teamId))),
    db
      .selectDistinct({ capability: folderGrantsTable.capability })
      .from(folderGrantsTable)
      .innerJoin(foldersTable, eq(foldersTable.id, folderGrantsTable.folderId))
      .where(
        and(eq(folderGrantsTable.userId, user.id), eq(foldersTable.teamId, teamId)),
      ),
    db
      .selectDistinct({ capability: projectGrantsTable.capability })
      .from(projectGrantsTable)
      .innerJoin(projectsTable, eq(projectsTable.id, projectGrantsTable.projectId))
      .where(
        and(eq(projectGrantsTable.userId, user.id), eq(projectsTable.teamId, teamId)),
      ),
  ]);
  const granted = [...fromApps, ...fromFolders, ...fromProjects].map(
    (r) => r.capability as Capability,
  );
  if (granted.length === 0) return own;
  // A grant bypasses `membershipFor`, so the token clamp has to be applied here
  // too — the same reason `lib/data/node-access.ts` ends with it.
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
 * Throws a user-facing "Unauthorized" — caught by the action `run()` wrapper.
 */
export async function requireCapability(
  cap: Capability,
): Promise<ActiveMembership> {
  const ctx = await requireMembership();
  if (!ctx.membership.capabilities.includes(cap)) {
    throw new Error(`You don't have permission to ${CAPABILITY_META[cap].label.toLowerCase()}`);
  }
  return ctx;
}

/* ------------------------------------------------------------------ */
/* Instance-admin (global scope)                                       */
/* ------------------------------------------------------------------ */

/**
 * True if the current user is a global instance admin — the gate for the
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
 *
 * Otherwise a token minted by an admin would quietly administer users, servers
 * and the global environment — the exact implicit root the capability set exists
 * to remove, and one that no team capability can narrow (these gates never
 * consult them). A cookie session is unaffected: no token, no restriction.
 */
function tokenHoldsInstanceAdmin(): boolean {
  const token = currentIdentity()?.token;
  return !token || token.instanceAdmin;
}

/**
 * Refuse a resource that has no per-Project meaning to a principal who reaches
 * only part of this team — a narrowed API token, or a member whose ROLE is
 * scoped.
 *
 * Either way the capability set has already dropped every team-wide permission
 * (see {@link PROJECT_SCOPED_CAPABILITIES}, applied by `clampToToken` for a
 * token and at write time for a role), which closes the MUTATIONS. But `view` is
 * an always-on floor that no capability check consults, so team-wide READS need
 * this explicit refusal: the member roster, the other tokens, the registries,
 * the databases (which carry no `project_id` to scope by at all).
 *
 * Use it for collections and team-level actions. For a point lookup by id,
 * prefer behaving as NOT FOUND instead — a scope must never become an oracle for
 * whether some id exists.
 *
 * The message names the right subject. Telling a person their SESSION is "an API
 * token limited to specific projects" is both confusing and a statement about
 * the enforcement mechanism that they did not ask for.
 *
 * Async, unlike the token half it replaces: a person's reach lives in the
 * database. Call it BEFORE opening a transaction — a query issued while one is
 * open waits on it, and under pglite that is a hang rather than a slow query.
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
 * The non-throwing twin of {@link requireTeamWide}, for a PAGE that has to
 * degrade rather than fail: a section outside someone's access should say so,
 * not render the error boundary over a healthy dashboard.
 *
 * True for every cookie session with an unscoped role and every unrestricted
 * token, which is every principal on every instance today.
 */
export async function reachesWholeTeam(): Promise<boolean> {
  if (narrowedScope()) return false;
  const user = await getCurrentUser();
  if (!user) return true;
  const teamId = await getActiveTeamId();
  if (!teamId) return true;
  return (await roleScopeFor(user.id, teamId)) == null;
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
 * True if the current user may publish container ports — a compose service's
 * `ports:` (bound to the host) or `expose:` (advertised to linked containers).
 * This is orthogonal to Traefik routing: giving an app a public DOMAIN does
 * NOT require this grant; only declaring published ports in the compose does.
 */
export async function canExposePorts(): Promise<boolean> {
  return hasGrant(await getCurrentUser(), "canExposePorts");
}

/** Throwing variant — gate any action that publishes container ports. */
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

/** Throwing variant — gate any host bind mount behind this. */
export async function requireMountHostVolumes(): Promise<{ userId: string }> {
  const user = await assertUser();
  if (!(await hasGrant(user, "canMountHostVolumes")))
    throw new Error(
      "You don't have permission to add a Bind (a folder on the server)",
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
  const secure = (process.env.DEPLO_PUBLIC_URL ?? "").startsWith("https://");
  store.set(ACTIVE_TEAM_COOKIE, teamId, {
    httpOnly: true,
    secure,
    sameSite: "lax",
    path: "/",
    maxAge: ACTIVE_TEAM_TTL_SECONDS,
  });
}

export { ACTIVE_TEAM_COOKIE };
