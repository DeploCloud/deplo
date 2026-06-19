import "server-only";

import { read, mutate } from "../store";
import { newId, nowIso } from "../ids";
import { assertUser } from "../auth";
import {
  requireActiveTeamId,
  requireCapability,
  setActiveTeam,
  teamsForUser,
  capabilitiesForRole,
} from "../membership";
import { recordActivity } from "./activity";
import type { Membership, Team } from "../types";

function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** The active team. */
export async function getTeam(): Promise<Team> {
  const teamId = await requireActiveTeamId();
  const t = read().teams.find((x) => x.id === teamId);
  if (!t) throw new Error("No team");
  return t;
}

/** Every team the current user belongs to (for the team switcher). */
export async function listMyTeams(): Promise<
  (Team & { role: string; memberCount: number })[]
> {
  const user = await assertUser();
  const d = read();
  return teamsForUser(user.id).map((t) => {
    const mine = d.memberships.find(
      (m) => m.userId === user.id && m.teamId === t.id,
    );
    return {
      ...t,
      role: mine?.role ?? "member",
      memberCount: d.memberships.filter((m) => m.teamId === t.id).length,
    };
  });
}

export async function updateTeam(input: {
  name: string;
  slug: string;
}): Promise<Team> {
  const { teamId } = await requireCapability("manage_team");
  const name = input.name.trim();
  const slug = slugify(input.slug);
  if (!name) throw new Error("Team name is required");
  if (!slug) throw new Error("Slug must contain letters or numbers");
  return mutate((d) => {
    const t = d.teams.find((x) => x.id === teamId);
    if (!t) throw new Error("No team");
    if (d.teams.some((x) => x.id !== t.id && x.slug === slug))
      throw new Error("That slug is already in use");
    t.name = name;
    t.slug = slug;
    return { ...t };
  });
}

/**
 * Create a brand-new team. The current user becomes its owner and the new team
 * is made active. A new team starts empty (it can target the shared servers).
 */
export async function createTeam(input: { name: string }): Promise<Team> {
  const user = await assertUser();
  const name = input.name.trim();
  if (!name) throw new Error("Team name is required");
  const d = read();
  let slug = slugify(name) || "team";
  let i = 1;
  while (d.teams.some((t) => t.slug === slug)) slug = `${slugify(name)}-${i++}`;
  const now = nowIso();
  const team: Team = {
    id: newId("team"),
    name,
    slug,
    plan: "pro",
    createdAt: now,
  };
  const membership: Membership = {
    id: newId("mbr"),
    userId: user.id,
    teamId: team.id,
    role: "owner",
    capabilities: capabilitiesForRole("owner"),
    createdAt: now,
  };
  mutate((data) => {
    data.teams.push(team);
    data.memberships.push(membership);
  });
  // Switch the active team to the freshly created one.
  await setActiveTeam(team.id);
  recordActivity("member", `Created team ${team.name}`, user.name, null, team.id);
  return team;
}

/** Switch the active team (validates membership inside setActiveTeam). */
export async function switchTeam(teamId: string): Promise<void> {
  await setActiveTeam(teamId);
}
