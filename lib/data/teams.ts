import "server-only";

import { read, mutate } from "../store";
import { assertUser } from "../auth";
import type { Team } from "../types";

function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export async function getTeam(): Promise<Team> {
  await assertUser();
  const t = read().teams[0];
  if (!t) throw new Error("No team");
  return t;
}

export async function updateTeam(input: {
  name: string;
  slug: string;
}): Promise<Team> {
  await assertUser();
  const name = input.name.trim();
  const slug = slugify(input.slug);
  if (!name) throw new Error("Team name is required");
  if (!slug) throw new Error("Slug must contain letters or numbers");
  return mutate((d) => {
    const t = d.teams[0];
    if (!t) throw new Error("No team");
    if (d.teams.some((x) => x.id !== t.id && x.slug === slug))
      throw new Error("That slug is already in use");
    t.name = name;
    t.slug = slug;
    return { ...t };
  });
}
