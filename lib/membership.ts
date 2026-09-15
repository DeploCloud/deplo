import "server-only";

import { cache } from "@/lib/request-cache";
import { cookies, headers } from "next/headers";
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "./db/client";
import { prepared } from "./db/prepared";
import { holdsAPasskey, passkeyCountsForThisRequest } from "./passkey-policy";
import { teamAvatarUrl } from "./avatar";
import {
  appGrants as appGrantsTable,
  folderGrants as folderGrantsTable,
  memberships as membershipsTable,
  membershipCapabilities as membershipCapabilitiesTable,
  projectGrants as projectGrantsTable,
  teamRoles as teamRolesTable,
} from "./db/schema/control-plane/access-control";
import { apps as appsTable } from "./db/schema/control-plane/apps";
import {
  teams as teamsTable,
  users as usersTable,
} from "./db/schema/control-plane/identity";
import {
  folders as foldersTable,
  projects as projectsTable,
} from "./db/schema/control-plane/projects";
import { assertUser, getCurrentUser } from "./auth/current-user";
import {
  ALL_CAPABILITIES,
  type Capability,
  type Membership,
} from "./types/identity";
import type { Team } from "./types/team";
import {
  CAPABILITY_META,
  PROJECT_SCOPED_CAPABILITIES,
  boundedBy,
} from "./membership-shared";
import { currentIdentity, narrowedScope } from "./auth/request-context";
import { requestIsHttps } from "./public-url";
import {
  ACTIVE_TEAM_COOKIE,
  ACTIVE_TEAM_TTL_SECONDS,
  TEAM_HEADER,
  pickActiveTeam,
} from "./team-path";
import { memberScopeFor, type NodeScope } from "./data/node-scope";

export {
  CAPABILITY_PRESETS,
  CAPABILITY_META,
  capabilitiesForRole,
  roleLabelForCapabilities,
} from "./membership-shared";

export const teamsWhereUserHolds = cache(async function teamsWhereUserHolds(
  userId: string,
  cap: Capability,
): Promise<Set<string>> {
  const rows = await prepared("teams-where-user-holds", (db) =>
    db
      .select({ teamId: membershipsTable.teamId })
      .from(membershipsTable)
      .innerJoin(
        membershipCapabilitiesTable,
        eq(membershipCapabilitiesTable.membershipId, membershipsTable.id),
      )
      .where(
        and(
          eq(membershipsTable.userId, sql.placeholder("userId")),
          eq(membershipCapabilitiesTable.capability, sql.placeholder("cap")),
        ),
      ),
  ).execute({ userId, cap });
  return new Set(rows.map((r) => r.teamId));
});

export const teamsForUser = cache(async (userId: string): Promise<Team[]> => {
  const rows = await prepared("teams-for-user", (db) =>
    db
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
      .where(eq(membershipsTable.userId, sql.placeholder("userId")))
      .orderBy(teamsTable.createdAt),
  ).execute({ userId });
  return rows.map((t) => ({
    id: t.id,
    name: t.name,
    slug: t.slug,
    plan: t.plan as Team["plan"],
    founderUserId: t.founderUserId ?? null,
    avatarUrl: teamAvatarUrl(t.image),
    createdAt: t.createdAt,
  }));
});

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
    if (!r) return { satisfied: true, reason: "" };
    if (r.enrolled) return { satisfied: true, reason: "" };
    if (r.hasPasskey && (await passkeyCountsForThisRequest()))
      return { satisfied: true, reason: "" };
    if (r.roleRequires)
      return { satisfied: false, reason: `The ${r.roleName} role` };
    if (r.teamRequires) return { satisfied: false, reason: r.teamName };
    return { satisfied: true, reason: "" };
  },
);

async function assertTwoFactor(userId: string, teamId: string): Promise<void> {
  const { satisfied, reason } = await twoFactorMandate(userId, teamId);
  if (!satisfied) throw new TwoFactorRequiredError(teamId, reason);
}

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

export const membershipFor = cache(async function membershipFor(
  userId: string,
  teamId: string,
): Promise<Membership | null> {
  await assertTwoFactor(userId, teamId);
  const rows = await prepared("membership-row", (db) =>
    db
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
          eq(membershipsTable.userId, sql.placeholder("userId")),
          eq(membershipsTable.teamId, sql.placeholder("teamId")),
        ),
      )
      .limit(1),
  ).execute({ userId, teamId });
  const m = rows[0];
  if (!m) return null;
  const caps = (
    await prepared("membership-capabilities", (db) =>
      db
        .select({ capability: membershipCapabilitiesTable.capability })
        .from(membershipCapabilitiesTable)
        .where(
          eq(membershipCapabilitiesTable.membershipId, sql.placeholder("id")),
        ),
    ).execute({ id: m.id })
  ).map((r) => r.capability as Capability);
  return {
    id: m.id,
    userId: m.userId,
    teamId: m.teamId,
    role: m.role as Membership["role"],
    capabilities: clampToToken(caps, userId, teamId),
    createdAt: m.createdAt,
  };
});

function clampToToken(
  caps: Capability[],
  userId: string,
  teamId: string,
): Capability[] {
  const id = currentIdentity();
  if (!id?.token || id.userId !== userId || id.teamId !== teamId) return caps;
  const own = boundedBy(caps, id.token.capabilities);
  // Depth strips, breadth does not: a token holding this team WHOLLY keeps every capability it was given.
  return narrowedScope() ? boundedBy(own, PROJECT_SCOPED_CAPABILITIES) : own;
}

export const clampCapabilitiesToToken = clampToToken;

export const getActiveTeamId = cache(async (): Promise<string | null> => {
  const user = await getCurrentUser();
  if (!user) return null;
  const teams = await teamsForUser(user.id);
  if (teams.length === 0) return null;
  const override = currentIdentity();
  if (override) {
    if (!teams.some((t) => t.id === override.teamId))
      throw new Error(
        "This request is scoped to a team the user no longer belongs to.",
      );
    return override.teamId;
  }
  const store = await cookies();
  return pickActiveTeam(
    teams,
    (await headers()).get(TEAM_HEADER),
    store.get(ACTIVE_TEAM_COOKIE)?.value,
  ).id;
});

export async function requireActiveTeamId(): Promise<string> {
  const teamId = await getActiveTeamId();
  if (!teamId) throw new Error("No active team");
  const user = await getCurrentUser();
  // The twin of the guard in membershipFor, and both are needed: reads never go through membershipFor.
  if (user) await assertTwoFactor(user.id, teamId);
  return teamId;
}

export interface ActiveMembership {
  userId: string;
  teamId: string;
  membership: Membership;
}

export async function requireMembership(): Promise<ActiveMembership> {
  const user = await assertUser();
  const teamId = await requireActiveTeamId();
  const membership = await membershipFor(user.id, teamId);
  if (!membership) throw new Error("Not a member of this team");
  return { userId: user.id, teamId, membership };
}

export async function hasCapability(cap: Capability): Promise<boolean> {
  const user = await getCurrentUser();
  if (!user) return false;
  const teamId = await getActiveTeamId();
  if (!teamId) return false;
  const m = await membershipFor(user.id, teamId);
  return Boolean(m && m.capabilities.includes(cap));
}

export async function currentCapabilities(): Promise<Capability[]> {
  const user = await getCurrentUser();
  if (!user) return [];
  const teamId = await getActiveTeamId();
  if (!teamId) return [];
  return (await membershipFor(user.id, teamId))?.capabilities ?? [];
}

export const reachableCapabilities = cache(async (): Promise<Capability[]> => {
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
  const union = new Set<Capability>([
    ...own,
    // A node grant bypasses membershipFor, so the token clamp has to be applied here too.
    ...clampToToken(granted, user.id, teamId),
  ]);
  return ALL_CAPABILITIES.filter((c) => union.has(c));
});

export async function hasCapabilityAnywhere(cap: Capability): Promise<boolean> {
  return (await reachableCapabilities()).includes(cap);
}

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

export async function isInstanceAdmin(): Promise<boolean> {
  const user = await getCurrentUser();
  if (!user?.isInstanceAdmin) return false;
  return tokenHoldsInstanceAdmin();
}

export async function requireInstanceAdmin(): Promise<{ userId: string }> {
  const user = await assertUser();
  if (!user.isInstanceAdmin || !tokenHoldsInstanceAdmin())
    throw new Error("Only an instance admin can do that");
  return { userId: user.id };
}

// Instance-admin is opt-in PER TOKEN, never inherited from the person holding it.
function tokenHoldsInstanceAdmin(): boolean {
  const token = currentIdentity()?.token;
  return !token || token.instanceAdmin;
}

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

export async function holdsTeamWideCapability(
  teamId: string,
  cap: Capability,
): Promise<boolean> {
  const user = await getCurrentUser();
  if (!user) return false;
  const token = currentIdentity()?.token;
  if (token) {
    if (!token.capabilities.includes(cap)) return false;
    if (token.scope && !token.scope.wholeTeamIds.includes(teamId)) return false;
  }
  if ((await memberScopeFor(user.id, teamId)) != null) return false;
  try {
    const m = await membershipFor(user.id, teamId);
    return Boolean(m?.capabilities.includes(cap));
  } catch {
    return false;
  }
}

export async function currentMemberScope(): Promise<NodeScope | null> {
  const user = await getCurrentUser();
  if (!user) return null;
  const teamId = await getActiveTeamId();
  if (!teamId) return null;
  if (await isInstanceAdmin()) return null;
  return memberScopeFor(user.id, teamId);
}

export async function reachesWholeTeam(): Promise<boolean> {
  if (narrowedScope()) return false;
  const user = await getCurrentUser();
  // Fail closed: the next caller will not prove a session first.
  if (!user) return false;
  const teamId = await getActiveTeamId();
  if (!teamId) return false;
  return (await memberScopeFor(user.id, teamId)) == null;
}

// Re-reads the stored user because the grant flags are server-enforced only and never ride on PublicUser.
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

export async function canExposePorts(): Promise<boolean> {
  return hasGrant(await getCurrentUser(), "canExposePorts");
}

export async function requireExposePorts(): Promise<{ userId: string }> {
  const user = await assertUser();
  if (!(await hasGrant(user, "canExposePorts")))
    throw new Error("You don't have permission to publish ports");
  return { userId: user.id };
}

export async function canMountHostVolumes(): Promise<boolean> {
  return hasGrant(await getCurrentUser(), "canMountHostVolumes");
}

export async function userMayReachHost(userId: string): Promise<boolean> {
  return hasGrant({ id: userId }, "canMountHostVolumes");
}

export async function requireMountHostVolumes(
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

export async function setActiveTeam(teamId: string): Promise<void> {
  const user = await assertUser();
  if (!(await membershipFor(user.id, teamId))) {
    throw new Error("Not a member of this team");
  }
  const store = await cookies();
  store.set(ACTIVE_TEAM_COOKIE, teamId, {
    httpOnly: true,
    secure: await requestIsHttps(),
    sameSite: "lax",
    path: "/",
    maxAge: ACTIVE_TEAM_TTL_SECONDS,
  });
}
