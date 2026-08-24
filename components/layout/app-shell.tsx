import { Sidebar } from "./sidebar";
import { SidebarProvider } from "./sidebar-state";
import { Topbar } from "./topbar";
import { ShellFrame } from "./shell-frame";
import { UpdateBanner } from "./update-banner";
import { NavigationHistoryTracker } from "./navigation-history";
import { DeployActivityProvider } from "./deploy-activity";
import { MigrationActivityProvider } from "./migration-activity";
import { TwoFactorReminder } from "@/components/security/two-factor-reminder";
import type { BreadcrumbGraph } from "@/lib/breadcrumb-model";
import type { PublicUser, TeamIdentity, TeamSummary } from "@/lib/types";

export function AppShell({
  user,
  team,
  teams,
  breadcrumb,
  capabilities,
  isAdmin,
  hasPasskey = false,
  children,
}: {
  user: PublicUser;
  team: TeamIdentity;
  teams: TeamSummary[];
  /** Team snapshot for the topbar breadcrumb (folders/apps/projects). */
  breadcrumb: BreadcrumbGraph;
  /** Current member's capabilities — drives capability-gated nav visibility. */
  capabilities: string[];
  /** Instance admin — gates admin-only nav (the Users settings section). */
  isAdmin: boolean;
  /** Holds a passkey that works here: already a second factor. */
  hasPasskey?: boolean;
  children: React.ReactNode;
}) {
  return (
    // The provider spans both panes: the sidebar collapses to zero width and the
    // topbar hosts the control that expands it again.
    <SidebarProvider>
      {/* Keyed by the active team: the live count is resolved server-side when
          the stream opens, so switching teams has to reconnect it. */}
      <DeployActivityProvider key={team.id}>
        <MigrationActivityProvider key={team.id}>
          {/* The frame itself is a client component: it reads the route, because
          the log consoles take the whole area to the right of the sidebar and
          every other page does not. Everything below is unchanged by that —
          `ShellFrame` renders the same markup for a normal route. Keyed by the
          active team so switching teams REMOUNTS the page instead of
          re-rendering it in place: switching keeps you on the open section (see
          lib/team-switch), and a client component that seeded state from its
          props at mount — a selected row, a filter, an open dialog, a live
          subscription — would otherwise keep pointing at the team you just
          left. */}
          <ShellFrame
            contentKey={team.id}
            sidebar={
              <>
                {/* Tracks in-app history depth so sidebar back links can use the
                browser's back when there's a page to return to (see
                navigation-history). */}
                <NavigationHistoryTracker />
                <Sidebar capabilities={capabilities} isAdmin={isAdmin} />
              </>
            }
            header={
              <>
                <Topbar
                  user={user}
                  team={team}
                  teams={teams}
                  breadcrumb={breadcrumb}
                  capabilities={capabilities}
                  isAdmin={isAdmin}
                />
                <UpdateBanner />
                {/* Renders nothing for an account that already has a second factor -
                an authenticator app OR a passkey (ADR-0024) - and nothing at all
                once the user has dismissed it for good. Nagging somebody who has
                set passkeys up is how a reminder teaches people to ignore it. */}
                <TwoFactorReminder
                  hasSecondFactor={user.twoFactorEnabled || hasPasskey}
                />
              </>
            }
          >
            {children}
          </ShellFrame>
        </MigrationActivityProvider>
      </DeployActivityProvider>
    </SidebarProvider>
  );
}
