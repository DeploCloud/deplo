"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter, usePathname } from "next/navigation";
import {
  ChevronDown,
  Menu,
  Search,
  Rocket,
  Database,
  LayoutTemplate,
  Globe,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { DeploLogo } from "@/components/logo";
import { SidebarNav } from "./sidebar-nav";
import { ThemeToggle } from "./theme-toggle";
import { UserMenu } from "./user-menu";
import type { PublicUser, Team } from "@/lib/types";

export function Topbar({
  user,
  team,
}: {
  user: PublicUser;
  team: Team;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [q, setQ] = React.useState("");
  const [mobileOpen, setMobileOpen] = React.useState(false);
  const searchRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (
        e.key.toLowerCase() === "f" &&
        (e.target as HTMLElement)?.tagName !== "INPUT" &&
        (e.target as HTMLElement)?.tagName !== "TEXTAREA"
      ) {
        e.preventDefault();
        searchRef.current?.focus();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function submitSearch(e: React.FormEvent) {
    e.preventDefault();
    router.push(q.trim() ? `/?q=${encodeURIComponent(q.trim())}` : "/");
  }

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
          <SidebarNav onNavigate={() => setMobileOpen(false)} />
        </SheetContent>
      </Sheet>

      {/* Team switcher */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent">
            <Avatar className="size-6">
              <AvatarFallback className="bg-foreground text-[10px] text-background">
                {team.name.slice(0, 2).toUpperCase()}
              </AvatarFallback>
            </Avatar>
            <span className="font-medium">{team.name}</span>
            <Badge variant="secondary" className="hidden capitalize sm:inline-flex">
              {team.plan}
            </Badge>
            <ChevronDown className="size-3.5 text-muted-foreground" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-60">
          <DropdownMenuLabel>Teams</DropdownMenuLabel>
          <DropdownMenuItem className="cursor-pointer">
            <Avatar className="size-5">
              <AvatarFallback className="bg-foreground text-[9px] text-background">
                {team.name.slice(0, 2).toUpperCase()}
              </AvatarFallback>
            </Avatar>
            {team.name}
            <Badge variant="secondary" className="ml-auto capitalize">
              {team.plan}
            </Badge>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <span className="hidden text-muted-foreground/40 sm:inline">/</span>
      <span className="hidden text-sm text-muted-foreground sm:inline">
        {breadcrumb(pathname)}
      </span>

      <div className="flex flex-1 items-center justify-end gap-2">
        {/* Search */}
        <form onSubmit={submitSearch} className="relative hidden w-full max-w-xs sm:block">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            ref={searchRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search…"
            className="h-8 pl-8 pr-8"
          />
          <kbd className="pointer-events-none absolute right-2 top-1/2 hidden -translate-y-1/2 rounded border border-border bg-muted px-1.5 text-[10px] text-muted-foreground md:inline">
            F
          </kbd>
        </form>

        {/* Add New */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" className="cursor-pointer">
              Add New
              <ChevronDown className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuItem asChild>
              <Link href="/new" className="cursor-pointer">
                <Rocket className="size-4" />
                Project
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link href="/templates" className="cursor-pointer">
                <LayoutTemplate className="size-4" />
                From Template
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link href="/storage" className="cursor-pointer">
                <Database className="size-4" />
                Database
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link href="/domains" className="cursor-pointer">
                <Globe className="size-4" />
                Domain
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
  const seg = pathname.split("/").filter(Boolean)[0] ?? "";
  return seg.charAt(0).toUpperCase() + seg.slice(1);
}
