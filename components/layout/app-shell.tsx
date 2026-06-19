import { Sidebar } from "./sidebar";
import { Topbar } from "./topbar";
import { UpdateBanner } from "./update-banner";
import type { PublicUser, Server, Team, TeamSummary } from "@/lib/types";

export function AppShell({
  user,
  team,
  teams,
  server,
  capabilities,
  children,
}: {
  user: PublicUser;
  team: Team;
  teams: TeamSummary[];
  server: Server | null;
  /** Current member's capabilities — drives capability-gated nav visibility. */
  capabilities: string[];
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen w-full">
      <Sidebar server={server} capabilities={capabilities} />

      {/* Main */}
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar user={user} team={team} teams={teams} capabilities={capabilities} />
        <UpdateBanner />
        <main className="flex-1 px-4 py-6 sm:px-6 lg:px-8">
          <div className="mx-auto w-full max-w-345">{children}</div>
        </main>
      </div>
    </div>
  );
}
