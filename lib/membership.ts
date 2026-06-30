import "server-only";

import { cache } from "react";
import { cookies } from "next/headers";
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "./db/client";
import {
  memberships as membershipsTable,
  membershipCapabilities as membershipCapabilitiesTable,
  teams as teamsTable,
  users as usersTable,
} from "./db/schema/control-plane";
import { assertUser, getCurrentUser } from "./auth";
import type { Capability, Membership, Team } from "./types";
import { CAPABILITY_META } from "./membership-shared";
import { currentIdentity } from "./auth/request-context";

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

/** The user's membership in a specific team (with capabilities), or null. */
export async function membershipFor(
  userId: string,
  teamId: string,
): Promise<Membership | null> {
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
    capabilities: caps,
    createdAt: m.createdAt,
  };
}

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
  // A bearer-token request is scoped to the token's team — provided it is one
  // the principal actually belongs to (defense-in-depth against a stale token).
  const override = currentIdentity();
  if (override) {
    return teams.some((t) => t.id === override.teamId)
      ? override.teamId
      : teams[0].id;
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
  return Boolean(user?.isInstanceAdmin);
}

/** Throwing variant for admin-only data functions / actions. */
export async function requireInstanceAdmin(): Promise<{ userId: string }> {
  const user = await assertUser();
  if (!user.isInstanceAdmin)
    throw new Error("Only an instance admin can manage users");
  return { userId: user.id };
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
 * This is orthogonal to Traefik routing: giving a service a public DOMAIN does
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
    throw new Error("You don't have permission to mount host volumes");
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
