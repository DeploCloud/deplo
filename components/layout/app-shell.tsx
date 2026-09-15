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
  hasPasskey?: boolean;
  children: React.ReactNode;
}) {
  return (
    <SidebarProvider>
      <LogsDisplayVars />
      <React.Suspense fallback={null}>
        <NavProgress />
      </React.Suspense>
      <DeployActivityProvider key={team.id}>
        <MigrationActivityProvider key={team.id}>
          <UpdateProvider enabled={isAdmin}>
            <ShellFrame
              contentKey={team.id}
              sidebar={
                <>
                  <NavigationHistoryTracker />
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
