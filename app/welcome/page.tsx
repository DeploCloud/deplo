import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { listMyTeams } from "@/lib/data/teams";
import { AuthChrome } from "@/components/auth/auth-chrome";
import { WelcomeCreateTeam } from "@/components/teams/welcome-create-team";

export const metadata = { title: "Create a team" };

/**
 * Landing screen for an authenticated user with ZERO teams - the dashboard
 * layout redirects here instead of throwing "No active team". Reachable after
 * their last team is deleted or they are removed from it.
 */
export default async function WelcomePage() {
  const user = await requireUser();
  const teams = await listMyTeams();
  if (teams.length > 0) redirect("/");
  return (
    <div className="relative grid min-h-dvh place-items-center px-4 pt-10 pb-16">
      <div className="deplo-grid-bg pointer-events-none absolute inset-0 opacity-[0.35]" />
      <AuthChrome />
      <div className="relative z-10 flex w-full justify-center">
        <WelcomeCreateTeam userName={user.name} />
      </div>
    </div>
  );
}
