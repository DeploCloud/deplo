import { redirect } from "next/navigation";

import { requireUser } from "@/lib/auth/current-user";
import { getActiveTeamId, teamsForUser } from "@/lib/membership";

// RootPage keeps the query: a full navigation to /?welcome=1 (the takeover landing) must arrive intact.
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
