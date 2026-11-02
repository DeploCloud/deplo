"use client";

import * as React from "react";
import { useFlatPathname } from "@/lib/nav";
import { Search, Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import Link from "@/components/ui/link";
import { DeploMark } from "@/components/logo";
import { SidebarExpandButton } from "./sidebar";
import { ThemeToggle } from "./theme-toggle";
import { MigrationChip } from "./migration-activity";
import { UpdateChip } from "./update-chip";
import { SecurityAlertPill } from "@/components/security-updates/security-alert-pill";
import { UserMenu } from "./user-menu";
import { openPalette } from "@/components/command-palette/palette-open";
import { TeamSwitcher } from "./team-switcher";
import { Breadcrumbs } from "./breadcrumbs";
import { isNonTeamSettings } from "./nav-config/active-route";
import type { BreadcrumbGraph } from "@/lib/breadcrumb-model";
import type { PublicUser } from "@/lib/types/identity";
import type { TeamIdentity, TeamSummary } from "@/lib/types/team";

export function Topbar({
  user,
  team,
  teams,
  breadcrumb: graph,
  capabilities = [],
  isAdmin = false,
}: {
  user: PublicUser;
  team: TeamIdentity;
  teams: TeamSummary[];
  breadcrumb: BreadcrumbGraph;
  capabilities?: string[];
  isAdmin?: boolean;
}) {
  const pathname = useFlatPathname();
  const hideTeam = isNonTeamSettings(pathname);

  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-border bg-background/80 px-4 backdrop-blur-md">
      <Link
        href="/"
        aria-label="Overview"
        className="-ml-2 grid size-11 place-items-center text-foreground md:hidden"
      >
        <DeploMark size={19} />
      </Link>
      <span className="-mx-1 text-xl text-ring md:hidden" aria-hidden>
        /
      </span>

      <SidebarExpandButton />

      {hideTeam ? (
        <span className="flex items-center gap-2 text-sm font-medium">
          <Settings className="size-4 text-muted-foreground" />
          Settings
        </span>
      ) : (
        <TeamSwitcher team={team} teams={teams} />
      )}

      <React.Suspense
        fallback={
          <span className="hidden items-center gap-2 sm:flex">
            <span className="text-muted-foreground/40">/</span>
            <span className="text-sm text-muted-foreground">
              {breadcrumb(pathname)}
            </span>
          </span>
        }
      >
        <Breadcrumbs
          pathname={pathname}
          graph={graph}
          capabilities={capabilities}
          fallback={breadcrumb(pathname)}
        />
      </React.Suspense>

      <div className="flex flex-1 items-center justify-end gap-2">
        <Button
          variant="ghost"
          size="icon-sm"
          className="md:hidden"
          aria-label="Search"
          aria-keyshortcuts="Meta+K Control+K"
          onClick={openPalette}
        >
          <Search className="size-5" />
        </Button>
        <MigrationChip canOpen={isAdmin} />
        <UpdateChip />
        <SecurityAlertPill teamId={team.id} />
        <span className="hidden md:contents">
          <ThemeToggle />
        </span>
        <UserMenu user={user} />
      </div>
    </header>
  );
}

const SEGMENT_LABELS: Record<string, string> = {
  agents: "AI agents",
  tokens: "API tokens",
};

function breadcrumb(pathname: string): string {
  if (pathname === "/") return "Overview";
  const segs = pathname.split("/").filter(Boolean);
  const seg =
    segs[0] === "settings" && segs.length > 1 ? segs[1] : (segs[0] ?? "");
  return SEGMENT_LABELS[seg] ?? seg.charAt(0).toUpperCase() + seg.slice(1);
}
