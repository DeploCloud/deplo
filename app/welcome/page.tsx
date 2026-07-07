import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { listMyTeams } from "@/lib/data/teams";
import { WelcomeCreateTeam } from "@/components/teams/welcome-create-team";

export const metadata = { title: "Create a team" };

/**
 * Landing screen for an authenticated user with ZERO teams — the dashboard
 * layout redirects here instead of throwing "No active team". Reachable after
 * their last team is deleted or they are removed from it.
 */
export default async function WelcomePage() {
  const user = await requireUser();
  const teams = await listMyTeams();
  if (teams.length > 0) redirect("/");
  return <WelcomeCreateTeam userName={user.name} />;
}
