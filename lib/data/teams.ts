import "server-only";

import { asc, count, eq } from "drizzle-orm";
import { getDb } from "../db/client";
import { currentIdentity } from "../auth/request-context";
import {
  memberships as membershipsTable,
  membershipCapabilities as membershipCapabilitiesTable,
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
  createdAt: string;
}): Team {
  return {
    id: t.id,
    name: t.name,
    slug: t.slug,
    plan: t.plan as Team["plan"],
    founderUserId: t.founderUserId ?? null,
    requireTwoFactor: t.requireTwoFactor ?? false,
    createdAt: t.createdAt,
  };
}

/**
 * Who the active team IS: its id, name and slug, and nothing else.
 *
 * Split from {@link getTeam} because the dashboard layout reads it on EVERY
 * page — the topbar names the team you are working in — while `getTeam` is a
 * team-wide read that a limited member is refused. Without the split, the one
 * `requireTeamWide` in `getTeam` took down every page under `(dashboard)` for
 * them: the layout's `try` catches only `TwoFactorRequiredError`, so it would
 * have surfaced as the error boundary on a perfectly healthy page.
 *
 * Nothing here is a setting, so nothing here needs the gate. A member of the
 * team may always know which team they are in.
 */
export async function getTeamIdentity(): Promise<
  Pick<Team, "id" | "name" | "slug">
> {
  const teamId = await requireActiveTeamId();
  const rows = await getDb()
    .select({
      id: teamsTable.id,
      name: teamsTable.name,
      slug: teamsTable.slug,
    })
    .from(teamsTable)
    .where(eq(teamsTable.id, teamId))
    .limit(1);
  const t = rows[0];
  if (!t) throw new Error("No team");
  return t;
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

/** Every team the current user belongs to (for the team switcher). */
export async function listMyTeams(): Promise<
  (Team & { role: string; memberCount: number })[]
> {
  const user = await assertUser();
  const db = getDb();
  // A bearer token acts only in the teams its scope names, so this is the list
  // it may switch between with `X-Deplo-Team` — not every team the person is in.
  const scope = currentIdentity()?.token?.scope;
  const teams = (await teamsForUser(user.id)).filter(
    (t) => !scope || scope.teamIds.includes(t.id),
  );
  if (teams.length === 0) return [];

  // The current user's role per team + each team's member count, in two queries.
  const mine = await db
    .select({ teamId: membershipsTable.teamId, role: membershipsTable.role })
    .from(membershipsTable)
    .where(eq(membershipsTable.userId, user.id));
  const roleByTeam = new Map(mine.map((m) => [m.teamId, m.role]));

  const counts = await db
    .select({ teamId: membershipsTable.teamId, n: count() })
    .from(membershipsTable)
    .groupBy(membershipsTable.teamId);
  const countByTeam = new Map(counts.map((c) => [c.teamId, Number(c.n)]));

  return teams.map((t) => ({
    ...t,
    role: roleByTeam.get(t.id) ?? "member",
    memberCount: countByTeam.get(t.id) ?? 0,
  }));
}

/**
 * Every team in the instance for the instance-admin registration-link picker
 * (assign a new user to existing teams). Gated by `requireInstanceAdmin` rather
 * than `manage_infra` — registering users is an instance-admin power, not a
 * per-team capability. Returns id/name/… only, no membership. Ordered by name.
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
  return getDb().transaction(async (tx) => {
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
    return rowToTeam({ ...t, name, slug, requireTwoFactor });
  });
}

/**
 * How many members of the active team have no second factor yet — what the team
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
    await tx
      .insert(membershipCapabilitiesTable)
      .values(
        capabilitiesForRole("owner").map((c) => ({
          membershipId,
          capability: c,
        })),
      );
    return t;
  });
  // Team ordering moved to the team_app_order/team_folder_order junctions
  // (cut-set c); a new team starts with no order rows. The JSONB stub is retired.
  // Switch the active team to the freshly created one.
  await setActiveTeam(team.id);
  await recordActivity("member", `Created team ${team.name}`, user.name, null, team.id);
  return team;
}

/** Switch the active team (validates membership inside setActiveTeam). */
export async function switchTeam(teamId: string): Promise<void> {
  await setActiveTeam(teamId);
}
