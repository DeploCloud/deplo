import * as React from "react";
import { Sidebar } from "./sidebar";
import { SidebarProvider } from "./sidebar-state";
import { Topbar } from "./topbar";
import { ShellFrame } from "./shell-frame";
import { UpdateProvider } from "./update-state";
import { NavigationHistoryTracker } from "./navigation-history";
import { NavProgress } from "./nav-progress";
import { GitConnectToast } from "@/components/shared/git-connect-toast";
import { DeployActivityProvider } from "./deploy-activity";
import { MigrationActivityProvider } from "./migration-activity";
import { LogsDisplayVars } from "@/components/shared/logs-display";
import { CommandPalette } from "@/components/command-palette/command-palette/palette-dialog";
import type { BreadcrumbGraph } from "@/lib/breadcrumb-model";
import type { PublicUser } from "@/lib/types/identity";
import type { TeamIdentity, TeamSummary } from "@/lib/types/team";

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
  breadcrumb: BreadcrumbGraph;
  capabilities: string[];
  isAdmin: boolean;
  // A passkey that works here already counts as a second factor (ADR-0024).
  hasPasskey?: boolean;
  children: React.ReactNode;
}) {
  return (
    // Spans both panes: the sidebar collapses to zero width and the topbar hosts the control that expands it again.
    <SidebarProvider>
      {/* Reads the stored log type size so a pane without the menu matches. */}
      <LogsDisplayVars />
      {/* Suspense because it reads the query string, which the Overview's drill-ins navigate with. */}
      <React.Suspense fallback={null}>
        <NavProgress />
      </React.Suspense>
      {/* Keyed by team: the live count resolves server-side when the stream opens, so a team switch must reconnect it. */}
      <DeployActivityProvider key={team.id}>
        <MigrationActivityProvider key={team.id}>
          <UpdateProvider enabled={isAdmin}>
            {/* A client component because it reads the route: the log consoles take the whole area right of the sidebar, no other page does. */}
            <ShellFrame
              contentKey={team.id}
              sidebar={
                <>
                  {/* Tracks in-app history depth so back links can use the browser's back when there is a page to return to. */}
                  <NavigationHistoryTracker />
                  {/* Connecting a git host ends on whatever page started it, so its one-shot confirmation is mounted once here. */}
                  <GitConnectToast />
                  <Sidebar
                    capabilities={capabilities}
                    isAdmin={isAdmin}
                    hasSecondFactor={user.twoFactorEnabled || hasPasskey}
                  />
                </>
              }
              header={
                <Topbar
                  user={user}
                  team={team}
                  teams={teams}
                  breadcrumb={breadcrumb}
                  capabilities={capabilities}
                  isAdmin={isAdmin}
                />
              }
            >
              {children}
            </ShellFrame>
            <CommandPalette
              userId={user.id}
              team={team}
              teams={teams}
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
