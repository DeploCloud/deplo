"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { PanelLeftClose, PanelLeftOpen, Search } from "lucide-react";
import { DeploLogo, DeploMark } from "@/components/logo";
import { SidebarNav } from "./sidebar-nav";
import { useSidebar } from "./sidebar-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * Desktop sidebar. Collapses fully to zero width — the control that brings it
 * back lives in the topbar (see SidebarExpandButton) — and, when open, can be
 * dragged wider or narrower. Collapsed flag and width come from SidebarProvider,
 * which persists them; the width transition is suppressed during a drag and on
 * first paint so neither animates unexpectedly.
 */
export function Sidebar({
  capabilities = [],
  isAdmin = false,
}: {
  capabilities?: string[];
  isAdmin?: boolean;
}) {
  const router = useRouter();
  const { collapsed, hydrated, width, dragging, toggle, startResize } =
    useSidebar();
  const [query, setQuery] = React.useState("");
  const searchRef = React.useRef<HTMLInputElement>(null);

  // "/" focuses search.
  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.key !== "/") return;
      e.preventDefault();
      searchRef.current?.focus();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function submitSearch(e: React.FormEvent) {
    e.preventDefault();
    const q = query.trim();
    router.push(q ? `/?q=${encodeURIComponent(q)}` : "/");
  }

  return (
    <aside
      data-collapsed={collapsed}
      style={{ width: collapsed ? 0 : width }}
      className={cn(
        "sticky top-0 hidden h-screen shrink-0 flex-col overflow-hidden border-r border-sidebar-border bg-sidebar md:flex",
        hydrated && !dragging && "transition-[width] duration-200 ease-out",
        collapsed && "border-r-0",
      )}
    >
      <div
        className={cn(
          "flex h-14 items-center",
          collapsed ? "justify-center px-2" : "justify-between gap-2 pl-5 pr-2",
        )}
      >
        <Link href="/" className="cursor-pointer" aria-label="Deplo home">
          {collapsed ? <DeploMark /> : <DeploLogo />}
        </Link>

        {!collapsed && (
          <Tooltip delayDuration={400}>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={toggle}
                aria-label="Collapse sidebar"
                className="shrink-0 text-muted-foreground"
              >
                <PanelLeftClose className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right">
              Collapse sidebar
              <kbd className="ml-1.5 rounded border border-border bg-muted px-1 text-[10px]">
                [
              </kbd>
            </TooltipContent>
          </Tooltip>
        )}
      </div>

      {/* Search */}
      <div className="px-3 pb-2">
        <form onSubmit={submitSearch} className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search apps…"
            aria-label="Search apps"
            className="h-9 pl-8 pr-7"
          />
          <kbd className="pointer-events-none absolute right-2 top-1/2 hidden -translate-y-1/2 rounded border border-border bg-muted px-1.5 text-[10px] text-muted-foreground lg:inline">
            /
          </kbd>
        </form>
      </div>

      <div className="flex-1 overflow-y-auto overflow-x-hidden">
        <SidebarNav
          collapsed={collapsed}
          capabilities={capabilities}
          isAdmin={isAdmin}
        />
      </div>

      {/* Drag-to-resize handle on the right edge */}
      <div
        onPointerDown={startResize}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        className={cn(
          "absolute right-0 top-0 z-20 h-full w-1.5 cursor-col-resize touch-none transition-colors hover:bg-foreground/15",
          dragging && "bg-foreground/25",
        )}
      />
    </aside>
  );
}

/**
 * Brings the sidebar back once it has collapsed to zero width. It renders at the
 * head of the topbar (desktop only — the mobile nav is a sheet with its own
 * trigger) so the control stays top-left, in line with the collapse button.
 */
export function SidebarExpandButton() {
  const { collapsed, toggle } = useSidebar();
  if (!collapsed) return null;

  return (
    <Tooltip delayDuration={400}>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={toggle}
          aria-label="Expand sidebar"
          className="hidden shrink-0 text-muted-foreground md:flex"
        >
          <PanelLeftOpen className="size-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        Expand sidebar
        <kbd className="ml-1.5 rounded border border-border bg-muted px-1 text-[10px]">
          [
        </kbd>
      </TooltipContent>
    </Tooltip>
  );
}
