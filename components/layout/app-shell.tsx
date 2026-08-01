import { Sidebar } from "./sidebar";
import { SidebarProvider } from "./sidebar-state";
import { Topbar } from "./topbar";
import { UpdateBanner } from "./update-banner";
import { NavigationHistoryTracker } from "./navigation-history";
import type { BreadcrumbGraph } from "@/lib/breadcrumb-model";
import type { PublicUser, Team, TeamSummary } from "@/lib/types";

export function AppShell({
  user,
  team,
  teams,
  breadcrumb,
  capabilities,
  isAdmin,
  children,
}: {
  user: PublicUser;
  team: Team;
  teams: TeamSummary[];
  /** Team snapshot for the topbar breadcrumb (folders/apps/projects). */
  breadcrumb: BreadcrumbGraph;
  /** Current member's capabilities — drives capability-gated nav visibility. */
  capabilities: string[];
  /** Instance admin — gates admin-only nav (the Users settings section). */
  isAdmin: boolean;
  children: React.ReactNode;
}) {
  return (
    // The provider spans both panes: the sidebar collapses to zero width and the
    // topbar hosts the control that expands it again.
    <SidebarProvider>
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
            breadcrumb={breadcrumb}
            capabilities={capabilities}
            isAdmin={isAdmin}
          />
          <UpdateBanner />
          <main className="flex-1 px-4 py-6 sm:px-6 lg:px-8">
            {/* Keyed by the active team so switching teams REMOUNTS the page
                instead of re-rendering it in place. Switching now keeps you on
                the open section (see lib/team-switch), and a client component
                that seeded state from its props at mount — a selected row, a
                filter, an open dialog, a live subscription — would otherwise
                keep pointing at the team you just left. */}
            <div key={team.id} className="mx-auto w-full max-w-345">
              {children}
            </div>
          </main>
        </div>
      </div>
    </SidebarProvider>
  );
}
