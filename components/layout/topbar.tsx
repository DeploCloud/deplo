"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ChevronDown,
  Menu,
  Rocket,
  Sparkles,
  Database,
  LayoutTemplate,
  Settings,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { DeploLogo } from "@/components/logo";
import { SidebarNav } from "./sidebar-nav";
import { ThemeToggle } from "./theme-toggle";
import { UserMenu } from "./user-menu";
import { TeamSwitcher } from "./team-switcher";
import { isNonTeamSettings } from "./nav-config";
import type { PublicUser, Team, TeamSummary } from "@/lib/types";

export function Topbar({
  user,
  team,
  teams,
  capabilities = [],
  isAdmin = false,
}: {
  user: PublicUser;
  team: Team;
  teams: TeamSummary[];
  capabilities?: string[];
  isAdmin?: boolean;
}) {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = React.useState(false);
  // Personal/system settings have no team context, so hide the team switcher
  // there and show a neutral "Settings" label in its place.
  const hideTeam = isNonTeamSettings(pathname);

  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-border bg-background/80 px-4 backdrop-blur-md">
      {/* Mobile menu */}
      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetTrigger asChild>
          <Button variant="ghost" size="icon-sm" className="md:hidden" aria-label="Menu">
            <Menu className="size-5" />
          </Button>
        </SheetTrigger>
        <SheetContent side="left" className="w-72 p-0">
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <div className="flex h-14 items-center border-b border-border px-5">
            <DeploLogo />
          </div>
          <SidebarNav
            onNavigate={() => setMobileOpen(false)}
            capabilities={capabilities}
            isAdmin={isAdmin}
          />
        </SheetContent>
      </Sheet>

      {/* Team switcher — replaced by a neutral label on personal/system settings,
          which act outside any single team. */}
      {hideTeam ? (
        <span className="flex items-center gap-2 text-sm font-medium">
          <Settings className="size-4 text-muted-foreground" />
          Settings
        </span>
      ) : (
        <TeamSwitcher team={team} teams={teams} />
      )}

      <span className="hidden text-muted-foreground/40 sm:inline">/</span>
      <span className="hidden text-sm text-muted-foreground sm:inline">
        {breadcrumb(pathname)}
      </span>

      <div className="flex flex-1 items-center justify-end gap-2">
        {/* Add New */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" className="cursor-pointer">
              Add New
              <ChevronDown className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuSub>
              <DropdownMenuSubTrigger className="cursor-pointer">
                <Rocket className="size-4" />
                New project
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuItem asChild>
                  <Link href="/new" className="cursor-pointer">
                    <Sparkles className="size-4" />
                    From Scratch
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link href="/templates" className="cursor-pointer">
                    <LayoutTemplate className="size-4" />
                    From Template
                  </Link>
                </DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuItem asChild>
              <Link href="/storage" className="cursor-pointer">
                <Database className="size-4" />
                Database
              </Link>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <ThemeToggle />
        <UserMenu user={user} />
      </div>
    </header>
  );
}

function breadcrumb(pathname: string): string {
  if (pathname === "/") return "Overview";
  const segs = pathname.split("/").filter(Boolean);
  // Under /settings show the subsection (Account, Servers, …) rather than a
  // generic "Settings"; elsewhere use the top-level segment.
  const seg =
    segs[0] === "settings" && segs.length > 1 ? segs[1] : segs[0] ?? "";
  return seg.charAt(0).toUpperCase() + seg.slice(1);
}
