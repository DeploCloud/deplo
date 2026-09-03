import { redirect } from "next/navigation";

import { requireUser } from "@/lib/auth";
import { getActiveTeamId, teamsForUser } from "@/lib/membership";

/**
 * The panel's front door. Every page lives in a team, so this one only decides
 * WHICH: the last one visited, else the first.
 */
export default async function RootPage() {
  const user = await requireUser();
  const teams = await teamsForUser(user.id);
  if (teams.length === 0) redirect("/welcome");
  const active = await getActiveTeamId();
  redirect(`/${teams.find((t) => t.id === active)?.slug ?? teams[0].slug}`);
}
