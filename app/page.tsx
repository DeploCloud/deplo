import { redirect } from "next/navigation";

import { requireUser } from "@/lib/auth";
import { getActiveTeamId, teamsForUser } from "@/lib/membership";

/**
 * The panel's front door. Every page lives in a team, so this one only decides
 * WHICH: the last one visited, else the first. The query rides along: a full
 * navigation to `/?welcome=1` (the takeover's landing) has to arrive intact.
 */
export default async function RootPage(props: PageProps<"/">) {
  const user = await requireUser();
  const teams = await teamsForUser(user.id);
  if (teams.length === 0) redirect("/welcome");
  const active = await getActiveTeamId();
  const query = new URLSearchParams();
  for (const [k, v] of Object.entries(await props.searchParams))
    for (const one of Array.isArray(v) ? v : v == null ? [] : [v])
      query.append(k, one);
  const q = query.toString();
  redirect(
    `/${teams.find((t) => t.id === active)?.slug ?? teams[0].slug}${q ? `?${q}` : ""}`,
  );
}
