import { Sidebar } from "./sidebar";
import { Topbar } from "./topbar";
import { UpdateBanner } from "./update-banner";
import { NavigationHistoryTracker } from "./navigation-history";
import type { PublicUser, Team, TeamSummary } from "@/lib/types";

export function AppShell({
  user,
  team,
  teams,
  capabilities,
  isAdmin,
  children,
}: {
  user: PublicUser;
  team: Team;
  teams: TeamSummary[];
  /** Current member's capabilities — drives capability-gated nav visibility. */
  capabilities: string[];
  /** Instance admin — gates admin-only nav (the Users settings section). */
  isAdmin: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen w-full">
      {/* Tracks in-app history depth so sidebar back links can use the browser's
          back when there's a page to return to (see navigation-history). */}
      <NavigationHistoryTracker />
      <Sidebar capabilities={capabilities} isAdmin={isAdmin} />

      {/* Main */}
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar
          user={user}
          team={team}
          teams={teams}
          capabilities={capabilities}
          isAdmin={isAdmin}
        />
        <UpdateBanner />
        <main className="flex-1 px-4 py-6 sm:px-6 lg:px-8">
          <div className="mx-auto w-full max-w-345">{children}</div>
        </main>
      </div>
    </div>
  );
}
