import * as React from "react";
import { Sidebar } from "./sidebar";
import { SidebarProvider } from "./sidebar-state";
import { Topbar } from "./topbar";
import { ShellFrame } from "./shell-frame";
import { UpdateBanner } from "./update-banner";
import { UpdateProvider } from "./update-state";
import { NavigationHistoryTracker } from "./navigation-history";
import { NavProgress } from "./nav-progress";
import { GitConnectToast } from "@/components/shared/git-connect-toast";
import { DeployActivityProvider } from "./deploy-activity";
import { MigrationActivityProvider } from "./migration-activity";
import { LogsDisplayVars } from "@/components/shared/logs-display";
import { CommandPalette } from "@/components/command-palette/command-palette";
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
  /** Current member's capabilities - drives capability-gated nav visibility. */
  capabilities: string[];
  /** Instance admin - gates admin-only nav (the Users settings section). */
  isAdmin: boolean;
  /** Holds a passkey that works here: already a second factor (ADR-0024). */
  hasPasskey?: boolean;
  children: React.ReactNode;
}) {
  return (
    // The provider spans both panes: the sidebar collapses to zero width and the
    // topbar hosts the control that expands it again.
    <SidebarProvider>
      {/* Reads the stored log type size so a pane without the menu matches. */}
      <LogsDisplayVars />
      {/* Suspense because it reads the query string, which the Overview's
          drill-ins navigate with. */}
      <React.Suspense fallback={null}>
        <NavProgress />
      </React.Suspense>
      {/* Keyed by the active team: the live count is resolved server-side when
          the stream opens, so switching teams has to reconnect it. */}
      <DeployActivityProvider key={team.id}>
        <MigrationActivityProvider key={team.id}>
          <UpdateProvider>
            {/**
             * The frame itself is a client component: it reads the route, because the log
             * consoles take the whole area to the right of the sidebar and every other page
             * does not.
             */}
            <ShellFrame
              contentKey={team.id}
              sidebar={
                <>
                  {/* Tracks in-app history depth so sidebar back links can use the
                browser's back when there's a page to return to (see
                navigation-history). */}
                  <NavigationHistoryTracker />
                  {/* Connecting a git host ends on whatever page started it, so
                    its one-shot confirmation is mounted once here rather than
                    on Settings → Git. */}
                  <GitConnectToast />
                  <Sidebar
                    capabilities={capabilities}
                    isAdmin={isAdmin}
                    hasSecondFactor={user.twoFactorEnabled || hasPasskey}
                  />
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
                </>
              }
            >
              {children}
            </ShellFrame>
            <CommandPalette
              userId={user.id}
              team={team}
              breadcrumb={breadcrumb}
              capabilities={capabilities}
              isAdmin={isAdmin}
            />
          </UpdateProvider>
        </MigrationActivityProvider>
      </DeployActivityProvider>
    </SidebarProvider>
  );
}
