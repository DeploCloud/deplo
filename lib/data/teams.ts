import "server-only";

import { and, asc, count, eq, inArray, isNull, sql } from "drizzle-orm";
import { getDb } from "../db/client";
import {
  currentIdentity,
  requirePersonalSession,
} from "../auth/request-context";
import {
  memberships as membershipsTable,
  membershipCapabilities as membershipCapabilitiesTable,
} from "../db/schema/control-plane/access-control";
import { apps as appsTable } from "../db/schema/control-plane/apps";
import { databases as databasesTable } from "../db/schema/control-plane/databases";
import {
  sharedEnvVars,
  sharedEnvVarTeams,
} from "../db/schema/control-plane/env-vars";
import {
  teams as teamsTable,
  users as usersTable,
} from "../db/schema/control-plane/identity";
import { newId, nowIso } from "../ids";
import { assertUser, getCurrentUser } from "../auth/current-user";
import {
  requireActiveTeamId,
  requireCapability,
  requireInstanceAdmin,
  setActiveTeam,
  teamsForUser,
  capabilitiesForRole,
  requireTeamWide,
  teamsWhereUserHolds,
} from "../membership";
import { recordActivity } from "./activity";
import { teamAvatarUrl } from "../avatar";
import { isValidTeamAvatarValue } from "../apps/avatar-shared";
import type { Team } from "../types/team";
import { pickTeamSlug } from "../team-path";

function rowToTeam(t: {
  id: string;
  name: string;
  slug: string;
  plan: string;
  founderUserId?: string | null;
  requireTwoFactor?: boolean;
  image?: string | null;
  createdAt: string;
}): Team {
  return {
    id: t.id,
    name: t.name,
    slug: t.slug,
    plan: t.plan as Team["plan"],
    founderUserId: t.founderUserId ?? null,
    requireTwoFactor: t.requireTwoFactor ?? false,
    avatarUrl: teamAvatarUrl(t.image),
    createdAt: t.createdAt,
  };
}

// getTeamIdentity - id, name and slug of the active team; nothing here is a setting, so no gate.
export async function getTeamIdentity(): Promise<
  Pick<Team, "id" | "name" | "slug" | "avatarUrl">
> {
  const teamId = await requireActiveTeamId();
  const rows = await getDb()
    .select({
      id: teamsTable.id,
      name: teamsTable.name,
      slug: teamsTable.slug,
      image: teamsTable.image,
    })
    .from(teamsTable)
    .where(eq(teamsTable.id, teamId))
    .limit(1);
  const t = rows[0];
  if (!t) throw new Error("No team");
  // avatarUrl rides this ungated read because the topbar switcher's TRIGGER renders it,
  // and `getTeam`, the full row, is a team-wide read a limited member is refused.
  return {
    id: t.id,
    name: t.name,
    slug: t.slug,
    avatarUrl: teamAvatarUrl(t.image),
  };
}

// myTeamSlugOwning - the owning team's slug, only when the viewer is a member of it (ADR-0029).
export async function myTeamSlugOwning(
  what: "app" | "database",
  key: string,
): Promise<string | null> {
  const user = await getCurrentUser();
  if (!user) return null;
  const rows =
    what === "app"
      ? await getDb()
          .select({ teamId: appsTable.teamId })
          .from(appsTable)
          .where(eq(appsTable.slug, key))
          .limit(1)
      : await getDb()
          .select({ teamId: databasesTable.teamId })
          .from(databasesTable)
          .where(eq(databasesTable.id, key))
          .limit(1);
  const owner = rows[0]?.teamId;
  if (!owner) return null;
  return (
    (await teamsForUser(user.id)).find((t) => t.id === owner)?.slug ?? null
  );
}

// teamSlugById - takes the id because alert dispatch runs with no active team; a slug is not a secret.
export async function teamSlugById(teamId: string): Promise<string | null> {
  const rows = await getDb()
    .select({ slug: teamsTable.slug })
    .from(teamsTable)
    .where(eq(teamsTable.id, teamId))
    .limit(1);
  return rows[0]?.slug ?? null;
}

// getTeam - the active team, settings included. A team-wide read.
export async function getTeam(): Promise<Team> {
  await requireTeamWide("team settings");
  const teamId = await requireActiveTeamId();
  const rows = await getDb()
    .select()
    .from(teamsTable)
    .where(eq(teamsTable.id, teamId))
    .limit(1);
  const t = rows[0];
  if (!t) throw new Error("No team");
  return rowToTeam(t);
}

const TEAM_SETTINGS_CAPS = [
  "manage_team",
  "manage_members",
  "manage_roles",
  "delete_team",
];

// listMyTeams - every team the current user belongs to (the team switcher).
export async function listMyTeams(): Promise<
  (Team & { role: string; memberCount: number; canManage: boolean })[]
> {
  const user = await assertUser();
  const db = getDb();
  // A bearer token reaches only the teams its scope names AND where its owner may use tokens.
  const token = currentIdentity()?.token;
  const allowed = token
    ? await teamsWhereUserHolds(user.id, "manage_tokens")
    : null;
  const teams = (await teamsForUser(user.id)).filter(
    (t) =>
      !token ||
      ((!token.scope || token.scope.teamIds.includes(t.id)) &&
        allowed!.has(t.id)),
  );
  if (teams.length === 0) return [];

  const mine = await db
    .select({
      teamId: membershipsTable.teamId,
      role: membershipsTable.role,
      switcherPosition: membershipsTable.switcherPosition,
    })
    .from(membershipsTable)
    .where(eq(membershipsTable.userId, user.id));
  const roleByTeam = new Map(mine.map((m) => [m.teamId, m.role]));
  const positionByTeam = new Map(
    mine.map((m) => [m.teamId, m.switcherPosition]),
  );

  // Cosmetic, like every UI capability check: it never decides what the settings page allows.
  const manageable = await db
    .select({ teamId: membershipsTable.teamId })
    .from(membershipCapabilitiesTable)
    .innerJoin(
      membershipsTable,
      eq(membershipsTable.id, membershipCapabilitiesTable.membershipId),
    )
    .where(
      and(
        eq(membershipsTable.userId, user.id),
        inArray(membershipCapabilitiesTable.capability, TEAM_SETTINGS_CAPS),
      ),
    );
  const canManageTeam = new Set(manageable.map((m) => m.teamId));

  const counts = await db
    .select({ teamId: membershipsTable.teamId, n: count() })
    .from(membershipsTable)
    .groupBy(membershipsTable.teamId);
  const countByTeam = new Map(counts.map((c) => [c.teamId, Number(c.n)]));

  return (
    teams
      .map((t) => ({
        ...t,
        role: roleByTeam.get(t.id) ?? "member",
        memberCount: countByTeam.get(t.id) ?? 0,
        canManage: canManageTeam.has(t.id),
      }))
      // NULLS LAST: a team never dragged keeps the order `teamsForUser` returned it in.
      .sort((a, b) => {
        const pa = positionByTeam.get(a.id);
        const pb = positionByTeam.get(b.id);
        if (pa == null && pb == null) return 0;
        if (pa == null) return 1;
        if (pb == null) return -1;
        return pa - pb;
      })
  );
}

// listAllTeamsForAdmin - every team in the instance, for the registration-link picker.
export async function listAllTeamsForAdmin(): Promise<Team[]> {
  await requireInstanceAdmin();
  const rows = await getDb()
    .select()
    .from(teamsTable)
    .orderBy(asc(teamsTable.name));
  return rows.map(rowToTeam);
}

export async function updateTeam(input: {
  name?: string;
  requireTwoFactor?: boolean;
}): Promise<Team> {
  const { teamId, userId } = await requireCapability("manage_team");
  const name = input.name?.trim();
  if (name !== undefined && !name) throw new Error("Team name is required");
  // Self-lockout guard: the policy would refuse the actor's very next request, read live.
  if (input.requireTwoFactor) {
    const me = (
      await getDb()
        .select({ enabled: usersTable.twoFactorEnabled })
        .from(usersTable)
        .where(eq(usersTable.id, userId))
        .limit(1)
    )[0];
    if (!me?.enabled)
      throw new Error(
        "Turn on two-factor authentication for your own account first, or you would lock yourself out.",
      );
  }
  const updated = await getDb().transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(teamsTable)
      .where(eq(teamsTable.id, teamId))
      .limit(1);
    const t = rows[0];
    if (!t) throw new Error("No team");
    const nextName = name ?? t.name;
    const requireTwoFactor = input.requireTwoFactor ?? t.requireTwoFactor;
    await tx
      .update(teamsTable)
      .set({ name: nextName, requireTwoFactor })
      .where(eq(teamsTable.id, t.id));
    return {
      team: rowToTeam({ ...t, name: nextName, requireTwoFactor }),
      policyChanged: requireTwoFactor !== t.requireTwoFactor,
    };
  });
  // Outside the transaction, per the recordActivity rule (own connection).
  if (updated.policyChanged)
    await recordActivity(
      "security",
      `Two-factor sign-in is now ${
        updated.team.requireTwoFactor ? "required" : "optional"
      } for this team`,
      (await assertUser()).name,
      null,
      teamId,
      "two_factor_policy_changed",
    );
  return updated.team;
}

// updateTeamAvatar - set or clear the team's picture, on the same gate that renames it.
export async function updateTeamAvatar(image: string | null): Promise<Team> {
  const { teamId } = await requireCapability("manage_team");
  const next = image?.trim() || null;
  if (next && !isValidTeamAvatarValue(next))
    throw new Error("Unsupported profile picture");

  const rows = await getDb()
    .update(teamsTable)
    .set({ image: next })
    .where(
      and(
        eq(teamsTable.id, teamId),
        sql`${teamsTable.image} is distinct from ${next}`,
      ),
    )
    .returning();

  if (rows[0])
    await recordActivity(
      "member",
      next ? `Changed the team picture` : `Removed the team picture`,
      (await assertUser()).name,
      null,
      teamId,
    );

  // Nothing changed ⇒ the row is still what it was; read it rather than lying.
  if (rows[0]) return rowToTeam(rows[0]);
  const current = await getDb()
    .select()
    .from(teamsTable)
    .where(eq(teamsTable.id, teamId))
    .limit(1);
  if (!current[0]) throw new Error("No team");
  return rowToTeam(current[0]);
}

// reorderMyTeams - a personal session only: an API token has no switcher to rewrite.
export async function reorderMyTeams(orderedIds: string[]): Promise<void> {
  const user = await assertUser();
  requirePersonalSession("your team order");

  await getDb().transaction(async (tx) => {
    const mine = await tx
      .select({ id: membershipsTable.id, teamId: membershipsTable.teamId })
      .from(membershipsTable)
      .where(eq(membershipsTable.userId, user.id));
    const idByTeam = new Map(mine.map((m) => [m.teamId, m.id]));

    const seen = new Set<string>();
    const next: string[] = [];
    for (const teamId of orderedIds) {
      if (idByTeam.has(teamId) && !seen.has(teamId)) {
        seen.add(teamId);
        next.push(teamId);
      }
    }
    for (const m of mine) if (!seen.has(m.teamId)) next.push(m.teamId);

    for (const [position, teamId] of next.entries()) {
      await tx
        .update(membershipsTable)
        .set({ switcherPosition: position })
        .where(eq(membershipsTable.id, idByTeam.get(teamId)!));
    }
  });
}

// membersWithoutTwoFactor - how many members have no second factor yet, before the policy goes on.
export async function membersWithoutTwoFactor(): Promise<{
  without: number;
  total: number;
}> {
  const teamId = await requireActiveTeamId();
  const rows = await getDb()
    .select({ enabled: usersTable.twoFactorEnabled })
    .from(membershipsTable)
    .innerJoin(usersTable, eq(usersTable.id, membershipsTable.userId))
    .where(eq(membershipsTable.teamId, teamId));
  return {
    without: rows.filter((r) => !r.enabled).length,
    total: rows.length,
  };
}

// createTeam - the current user becomes its owner, and the new team is made active.
export async function createTeam(input: {
  name: string;
  image?: string | null;
}): Promise<Team> {
  const user = await assertUser();
  const name = input.name.trim();
  if (!name) throw new Error("Team name is required");
  const image = input.image?.trim() || null;
  if (image && !isValidTeamAvatarValue(image))
    throw new Error("Unsupported profile picture");
  const now = nowIso();
  const team = await getDb().transaction(async (tx) => {
    const slug = pickTeamSlug(
      name,
      (await tx.select({ slug: teamsTable.slug }).from(teamsTable)).map(
        (r) => r.slug,
      ),
    );
    const t: Team = {
      id: newId("team"),
      name,
      slug,
      plan: "pro",
      founderUserId: user.id,
      avatarUrl: teamAvatarUrl(image),
      createdAt: now,
    };
    const membershipId = newId("mbr");
    await tx.insert(teamsTable).values({
      id: t.id,
      name: t.name,
      slug: t.slug,
      plan: t.plan,
      founderUserId: t.founderUserId,
      image,
      createdAt: t.createdAt,
    });
    await tx.insert(membershipsTable).values({
      id: membershipId,
      userId: user.id,
      teamId: t.id,
      role: "owner",
      createdAt: now,
    });
    await tx.insert(membershipCapabilitiesTable).values(
      capabilitiesForRole("owner").map((c) => ({
        membershipId,
        capability: c,
      })),
    );
    // Instance-wide means a team born now joins their reach set too (ADR-0027).
    const instanceVars = await tx
      .select({ id: sharedEnvVars.id })
      .from(sharedEnvVars)
      .where(isNull(sharedEnvVars.teamId));
    if (instanceVars.length > 0)
      await tx
        .insert(sharedEnvVarTeams)
        .values(instanceVars.map((v) => ({ varId: v.id, teamId: t.id })));
    return t;
  });
  await setActiveTeam(team.id);
  await recordActivity(
    "member",
    `Created team ${team.name}`,
    user.name,
    null,
    team.id,
  );
  return team;
}

// switchTeam - validates membership inside `setActiveTeam`.
export async function switchTeam(teamId: string): Promise<void> {
  await setActiveTeam(teamId);
}
