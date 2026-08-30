// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

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
  sharedEnvVars,
  sharedEnvVarTeams,
  teams as teamsTable,
  users as usersTable,
} from "../db/schema/control-plane";
import { newId, nowIso } from "../ids";
import { assertUser } from "../auth";
import {
  requireActiveTeamId,
  requireCapability,
  requireInstanceAdmin,
  setActiveTeam,
  teamsForUser,
  capabilitiesForRole,
  requireTeamWide,
} from "../membership";
import { recordActivity } from "./activity";
import { teamAvatarUrl } from "../avatar";
import { isValidAvatarValue } from "../apps/avatar-shared";
import type { Team } from "../types";

function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

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

/**
 * Who the active team IS: its id, name and slug, and nothing else. Nothing here is
 * a setting, so nothing here needs the gate.
 */
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
  // The picture belongs here and not only on the full row: this is what the
  // topbar switcher's TRIGGER renders, which is the single most-seen avatar in
  // the product. `getTeam` is a team-wide read a limited member is refused.
  return {
    id: t.id,
    name: t.name,
    slug: t.slug,
    avatarUrl: teamAvatarUrl(t.image),
  };
}

/** The active team, settings included. A team-wide read. */
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

/** The "team" browse category of lib/capabilities.ts: holding any of these means
 *  something in that team's settings is actually this person's to change. */
const TEAM_SETTINGS_CAPS = [
  "manage_team",
  "manage_members",
  "manage_roles",
  "delete_team",
];

/** Every team the current user belongs to (for the team switcher). */
export async function listMyTeams(): Promise<
  (Team & { role: string; memberCount: number; canManage: boolean })[]
> {
  const user = await assertUser();
  const db = getDb();
  // A bearer token acts only in the teams its scope names, so this is the list
  // it may switch between with `X-Deplo-Team`, not every team the person is in.
  const scope = currentIdentity()?.token?.scope;
  const teams = (await teamsForUser(user.id)).filter(
    (t) => !scope || scope.teamIds.includes(t.id),
  );
  if (teams.length === 0) return [];

  // The current user's role per team + each team's member count, in two queries.
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

  // Cosmetic only, like every UI capability check: it decides whether the switcher
  // offers a shortcut into a team's settings, never what that page then allows.
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
      // NULLS LAST, stable within each group: a team the user has never dragged
      // keeps the order `teamsForUser` already returned it in, so somebody who
      // never touches this sees no change at all.
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

/**
 * Every team in the instance for the instance-admin registration-link picker
 * (assign a new user to existing teams).
 */
export async function listAllTeamsForAdmin(): Promise<Team[]> {
  await requireInstanceAdmin();
  const rows = await getDb()
    .select()
    .from(teamsTable)
    .orderBy(asc(teamsTable.name));
  return rows.map(rowToTeam);
}

export async function updateTeam(input: {
  name: string;
  slug: string;
  requireTwoFactor?: boolean;
}): Promise<Team> {
  const { teamId, userId } = await requireCapability("manage_team");
  const name = input.name.trim();
  const slug = slugify(input.slug);
  if (!name) throw new Error("Team name is required");
  if (!slug) throw new Error("Slug must contain letters or numbers");
  // Self-lockout guard: switching the policy on while the actor has no second
  // factor would refuse their very next request, including the one that would
  // turn it back off. Read live rather than trusting the session's snapshot.
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
    const dup = await tx
      .select({ id: teamsTable.id })
      .from(teamsTable)
      .where(eq(teamsTable.slug, slug))
      .limit(1);
    if (dup[0] && dup[0].id !== t.id)
      throw new Error("That slug is already in use");
    const requireTwoFactor = input.requireTwoFactor ?? t.requireTwoFactor;
    await tx
      .update(teamsTable)
      .set({ name, slug, requireTwoFactor })
      .where(eq(teamsTable.id, t.id));
    return {
      team: rowToTeam({ ...t, name, slug, requireTwoFactor }),
      policyChanged: requireTwoFactor !== t.requireTwoFactor,
    };
  });
  // Outside the transaction, per the recordActivity rule (own connection). The
  // sign-in policy is the one field here that changes who can reach the team at
  // all, so it is the one worth a trail and an alert.
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

/**
 * Set or clear the active team's picture. `manage_team`, the same gate that
 * renames the team, because it IS the same action: changing how the team presents
 * itself.
 */
export async function updateTeamAvatar(image: string | null): Promise<Team> {
  const { teamId } = await requireCapability("manage_team");
  const next = image?.trim() || null;
  if (next && !isValidAvatarValue(next))
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

/**
 * This person's arrangement of the topbar team switcher. `requirePersonalSession`
 * is the gate that matters - an API token has no switcher and no business
 * rewriting somebody's.
 */
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

/**
 * How many members of the active team have no second factor yet - what the team
 * Security card shows before an admin flips the policy on, so "3 of 8 members"
 * is visible rather than discovered by those three being locked out.
 */
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

/**
 * Create a brand-new team. The current user becomes its owner and the new team
 * is made active. A new team starts empty (it can target the shared servers).
 */
export async function createTeam(input: { name: string }): Promise<Team> {
  const user = await assertUser();
  const name = input.name.trim();
  if (!name) throw new Error("Team name is required");
  const now = nowIso();
  const team = await getDb().transaction(async (tx) => {
    const taken = new Set(
      (await tx.select({ slug: teamsTable.slug }).from(teamsTable)).map(
        (r) => r.slug,
      ),
    );
    const base = slugify(name) || "team";
    let slug = base;
    for (let i = 1; taken.has(slug); i++) slug = `${base}-${i}`;
    const t: Team = {
      id: newId("team"),
      name,
      slug,
      plan: "pro",
      // The creator is the founder (absolute owner / "crown") of the new team.
      founderUserId: user.id,
      avatarUrl: null,
      createdAt: now,
    };
    const membershipId = newId("mbr");
    await tx.insert(teamsTable).values({
      id: t.id,
      name: t.name,
      slug: t.slug,
      plan: t.plan,
      founderUserId: t.founderUserId,
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
    // An instance-owned variable means instance-wide, not "the teams that existed
    // on upgrade day" - so a team born now joins their reach set (ADR-0027).
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
  // Team ordering moved to the team_app_order/team_folder_order junctions
  // (cut-set c); a new team starts with no order rows. The JSONB stub is retired.
  // Switch the active team to the freshly created one.
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

/** Switch the active team (validates membership inside setActiveTeam). */
export async function switchTeam(teamId: string): Promise<void> {
  await setActiveTeam(teamId);
}
