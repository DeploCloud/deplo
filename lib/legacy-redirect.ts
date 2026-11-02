import "server-only";

import { redirect } from "next/navigation";

import { getActiveTeamId, teamsForUser } from "./membership";
import { getCurrentUser } from "./auth/current-user";
import { myTeamSlugOwning } from "./data/teams";
import { withTeam } from "./team-path";

export type LegacyProps = {
  params: Promise<{ rest?: string[] }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

async function teamFor(
  section: string,
  rest: string[],
): Promise<string | null> {
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

// A moved page keeps the link's query, or a deep link lands on the page's first step.
export function querySuffix(
  params: Record<string, string | string[] | undefined>,
): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params))
    for (const one of Array.isArray(value) ? value : [value ?? ""])
      query.append(key, one);
  const search = query.toString();
  return search ? `?${search}` : "";
}

export async function legacyRedirect(
  section: string,
  props: LegacyProps,
): Promise<never> {
  const { rest = [] } = await props.params;
  const path = `/${[section, ...rest].join("/")}${querySuffix(await props.searchParams)}`;
  const slug = await teamFor(section, rest);
  // A stale session passes the proxy; sign-in keeps the target when safeNext allows it.
  if (!slug && !(await getCurrentUser()))
    redirect(`/login?next=${encodeURIComponent(path)}`);
  if (!slug) redirect("/welcome");
  redirect(withTeam(path, slug));
}
