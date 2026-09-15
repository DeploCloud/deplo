"use client";

import Link from "@/components/ui/link";

import { useFlatPathname } from "@/lib/nav";
import {
  BookOpen,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
} from "lucide-react";
import { DeploLogo } from "@/components/logo";
import { sidebarMenuFor } from "@/components/layout/nav-config/active-route";
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

const FOOTER_LINK =
  "group flex cursor-pointer items-center gap-2.5 rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-surface hover:text-foreground focus-visible:bg-surface";

export function Sidebar({
  capabilities = [],
  isAdmin = false,
  hasSecondFactor = true,
}: {
  capabilities?: string[];
  isAdmin?: boolean;
  hasSecondFactor?: boolean;
}) {
  const { menu } = sidebarMenuFor(useFlatPathname());
  const { collapsed, hydrated, width, peek, dragging, toggle, startResize } =
    useSidebar();
  return (
    <aside
      data-collapsed={collapsed}
      inert={collapsed}
      style={{ width: collapsed ? 0 : width - peek }}
      className={cn(
        "sticky top-0 hidden h-screen shrink-0 overflow-hidden border-r border-sidebar-border bg-sidebar md:block",
        hydrated && !dragging && "transition-[width] duration-200 ease-out",
        collapsed && "border-r-0",
      )}
    >
      <div
        style={{
          width,
          transform:
            collapsed || peek
              ? `translateX(-${collapsed ? width : peek}px)`
              : undefined,
        }}
        className={cn(
          "flex h-full flex-col",
          hydrated && !dragging && "transition-transform duration-200 ease-out",
        )}
      >
        <div className="flex h-14 items-center justify-between gap-2 pr-2 pl-5">
          <Link href="/" className="cursor-pointer" aria-label="Deplo home">
            <DeploLogo />
          </Link>

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
        </div>

        <div className="px-3 pb-1">
          <SearchTrigger />
        </div>

        <div className="flex-1 overflow-x-hidden overflow-y-auto">
          <SidebarNav capabilities={capabilities} isAdmin={isAdmin} />
        </div>

        {menu === "main" && (
          <div className="px-3 pb-2">
            <SidebarTips
              hasSecondFactor={hasSecondFactor}
              capabilities={capabilities}
              isAdmin={isAdmin}
            />
          </div>
        )}

        {menu === "main" && (
          <div className="space-y-0.5 border-t border-border p-2">
            <Tooltip delayDuration={400}>
              <TooltipTrigger asChild>
                <a
                  href={docsUrl("docs.home")}
                  target="_blank"
                  rel="noreferrer"
                  aria-label="Documentation"
                  className={FOOTER_LINK}
                >
                  <BookOpen className="size-4 shrink-0 group-hover:text-foreground" />
                  Documentation
                </a>
              </TooltipTrigger>
              <TooltipContent side="right">Documentation</TooltipContent>
            </Tooltip>
            <Tooltip delayDuration={400}>
              <TooltipTrigger asChild>
                <Link
                  href="/settings"
                  aria-label="Settings"
                  className={FOOTER_LINK}
                >
                  <Settings className="size-4 shrink-0 group-hover:text-foreground" />
                  Settings
                </Link>
              </TooltipTrigger>
              <TooltipContent side="right">Settings</TooltipContent>
            </Tooltip>
          </div>
        )}
      </div>

      <div
        onPointerDown={startResize}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        className={cn(
          "absolute top-0 right-0 z-20 h-full w-1.5 cursor-col-resize touch-none transition-colors hover:bg-border",
          dragging && "bg-ring",
        )}
      />
    </aside>
  );
}

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
