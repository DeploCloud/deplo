import "server-only";

import { redirect } from "next/navigation";

import { getActiveTeamId, teamsForUser } from "./membership";
import { getCurrentUser } from "./auth";
import { myTeamSlugOwning } from "./data/teams";
import { withTeam } from "./team-path";

/**
 * The shape every legacy stub page has: one optional catch-all under a section
 * that used to be a first segment (`/apps/web/logs`).
 */
export type LegacyProps = {
  params: Promise<{ rest?: string[] }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/** The team a flat address should open in - its resource's owner, or the last one visited. */
async function teamFor(
  section: string,
  rest: string[],
): Promise<string | null> {
  // A link written before the team was in the address is exactly the case this
  // exists for, so the OWNER of the resource wins over whatever is active.
  const owner =
    section === "apps" && rest[0]
      ? await myTeamSlugOwning("app", rest[0])
      : section === "storage" && rest[0] === "databases" && rest[1]
        ? await myTeamSlugOwning("database", rest[1])
        : null;
  if (owner) return owner;
  const user = await getCurrentUser();
  if (!user) return null;
  const teams = await teamsForUser(user.id);
  const active = await getActiveTeamId();
  return teams.find((t) => t.id === active)?.slug ?? teams[0]?.slug ?? null;
}

/**
 * Send a flat, pre-team address to the same page inside a team, query included.
 * Every one of these paths is a bookmark, a notification sent yesterday, or a
 * link someone pasted, so none of them is allowed to become a 404.
 */
export async function legacyRedirect(
  section: string,
  props: LegacyProps,
): Promise<never> {
  const { rest = [] } = await props.params;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(await props.searchParams))
    for (const one of Array.isArray(value) ? value : [value ?? ""])
      query.append(key, one);
  const search = query.toString();
  const path = `/${[section, ...rest].join("/")}${search ? `?${search}` : ""}`;
  const slug = await teamFor(section, rest);
  // No team to open it in - the same place the dashboard sends someone with none.
  if (!slug) redirect("/welcome");
  redirect(withTeam(path, slug));
}
