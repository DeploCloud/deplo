"use client";

import Link from "next/link";

import { usePathname } from "next/navigation";
import {
  BookOpen,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
} from "lucide-react";
import { DeploLogo, DeploMark } from "@/components/logo";
import { sidebarMenuFor } from "@/components/layout/nav-config";
import { SidebarNav } from "./sidebar-nav";
import { SidebarTips } from "./sidebar-tips";
import { useSidebar } from "./sidebar-state";
import { Button } from "@/components/ui/button";
import { SearchTrigger } from "@/components/command-palette/palette-kbd";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { docsUrl } from "@/lib/docs";

/**
 * Desktop sidebar. Collapsed flag and width come from SidebarProvider, which
 * persists them; the width transition is suppressed during a drag and on first
 * paint so neither animates unexpectedly.
 */
/** The two rows in the sidebar's footer wear one shape. */
const FOOTER_LINK =
  "group flex cursor-pointer items-center gap-2.5 rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground focus-visible:bg-foreground/5";
const FOOTER_LINK_COLLAPSED = "h-9 w-9 justify-center px-0";

export function Sidebar({
  capabilities = [],
  isAdmin = false,
  hasSecondFactor = true,
}: {
  capabilities?: string[];
  isAdmin?: boolean;
  /** Feeds the nudge cards above the footer; see sidebar-tips. */
  hasSecondFactor?: boolean;
}) {
  // The footer stands down inside a drill-in; the nav there has its own way out.
  const { menu } = sidebarMenuFor(usePathname());
  const { collapsed, hydrated, width, dragging, toggle, startResize } =
    useSidebar();
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
          collapsed ? "justify-center px-2" : "px-5",
        )}
      >
        <Link href="/" className="cursor-pointer" aria-label="Deplo home">
          {collapsed ? <DeploMark /> : <DeploLogo />}
        </Link>
      </div>

      {/* Opens the command palette - the sidebar has no search of its own. */}
      <div className="px-3 pb-1">
        <SearchTrigger />
      </div>

      <div className="flex-1 overflow-x-hidden overflow-y-auto">
        <SidebarNav
          collapsed={collapsed}
          capabilities={capabilities}
          isAdmin={isAdmin}
        />
      </div>

      {/* Nudges sit above the footer and only in the main menu: a drill-in's nav
          is a place someone went on purpose, and the collapsed rail has no room
          for prose. */}
      {menu === "main" && !collapsed && (
        <div className="px-3 pb-2">
          <SidebarTips
            hasSecondFactor={hasSecondFactor}
            capabilities={capabilities}
            isAdmin={isAdmin}
          />
        </div>
      )}

      {/* Outside the scroller: the manual and the way into Settings are both
          reachable from any page, however far down the nav has been scrolled.
          Settings sits here rather than in the workspace nav because it is a
          way OUT of the workspace, not a place in it - and for the same reason
          it is gone inside a drill-in, where the nav's own first row is the way
          back and a second exit underneath only competes with it. */}
      {menu === "main" && (
        <div
          className={cn(
            "space-y-0.5 border-t border-border p-2",
            collapsed && "px-1.5",
          )}
        >
          <Tooltip delayDuration={collapsed ? 0 : 400}>
            <TooltipTrigger asChild>
              <a
                href={docsUrl("docs.home")}
                target="_blank"
                rel="noreferrer"
                aria-label="Documentation"
                className={cn(FOOTER_LINK, collapsed && FOOTER_LINK_COLLAPSED)}
              >
                <BookOpen className="size-4 shrink-0 group-hover:text-foreground" />
                {!collapsed && "Documentation"}
              </a>
            </TooltipTrigger>
            <TooltipContent side="right">Documentation</TooltipContent>
          </Tooltip>
          <Tooltip delayDuration={collapsed ? 0 : 400}>
            <TooltipTrigger asChild>
              <Link
                href="/settings"
                aria-label="Settings"
                className={cn(FOOTER_LINK, collapsed && FOOTER_LINK_COLLAPSED)}
              >
                <Settings className="deplo-gear size-4 shrink-0 group-hover:text-foreground" />
                {!collapsed && "Settings"}
              </Link>
            </TooltipTrigger>
            <TooltipContent side="right">Settings</TooltipContent>
          </Tooltip>
        </div>
      )}

      {/* Drag-to-resize handle on the right edge; the collapse control rides
          its middle and appears on hover. */}
      <div
        onPointerDown={startResize}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        className={cn(
          "group absolute top-0 right-0 z-20 h-full w-1.5 cursor-col-resize touch-none transition-colors hover:bg-foreground/15",
          dragging && "bg-foreground/25",
        )}
      >
        {!collapsed && (
          <Tooltip delayDuration={400}>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={toggle}
                aria-label="Collapse sidebar"
                className="absolute top-1/2 right-1 size-6 -translate-y-1/2 cursor-pointer rounded-full border border-sidebar-border bg-sidebar text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
              >
                <PanelLeftClose className="size-3.5" />
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
    </aside>
  );
}

/**
 * Brings the sidebar back once it has collapsed to zero width. It renders at the
 * head of the topbar (desktop only - the mobile nav is a sheet with its own
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
