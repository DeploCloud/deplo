"use client";

import * as React from "react";
import Link from "@/components/ui/link";

import { useFlatPathname } from "@/lib/nav";
import {
  BookOpen,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
} from "lucide-react";
import { DeploLogo, DeploMark } from "@/components/logo";
import { sidebarMenuFor } from "@/components/layout/nav-config/active-route";
import { NavLabel, SidebarNav, SubmenuChevron } from "./sidebar-nav";
import { SidebarTips } from "./sidebar-tips";
import { RAIL_WIDTH, useSidebar } from "./sidebar-state";
import {
  PaletteKbd,
  SearchTrigger,
} from "@/components/command-palette/palette-kbd";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { docsUrl } from "@/lib/docs";

const FADE = "transition-opacity duration-200";

const FOOTER_LINK =
  "group flex h-10 w-full cursor-pointer items-center gap-2.5 overflow-hidden rounded-md px-3 text-left text-sm whitespace-nowrap text-muted-foreground transition-colors hover:bg-surface hover:text-foreground focus-visible:bg-surface";

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
  const {
    mode,
    hydrated,
    width,
    peek,
    dragging,
    following,
    toggle,
    startResize,
    resetWidth,
  } = useSidebar();
  const rail = mode === "rail";
  const tipDelay = rail ? 0 : 400;
  return (
    <aside
      style={{ width: rail ? RAIL_WIDTH : width - peek }}
      className={cn(
        "sticky top-0 hidden h-screen shrink-0 overflow-hidden border-r border-sidebar-border bg-sidebar md:block",
        hydrated && !following && "transition-[width] duration-200 ease-out",
      )}
    >
      <div
        style={{ width: rail ? RAIL_WIDTH : width }}
        className={cn(
          "flex h-full flex-col",
          hydrated && !following && "transition-[width] duration-200 ease-out",
        )}
      >
        <div className="flex h-14 items-center pr-2 pl-5">
          <Link
            href="/"
            className="relative cursor-pointer"
            aria-label="Deplo home"
          >
            <DeploLogo className={cn(FADE, rail && "opacity-0")} />
            {/* Centred in the rail, 2px left of the wordmark's edge. */}
            <DeploMark
              className={cn(
                "absolute top-1/2 -left-0.5 -translate-y-1/2",
                FADE,
                !rail && "opacity-0",
              )}
            />
          </Link>
        </div>

        <div className="px-2 pb-1">
          <Tooltip delayDuration={tipDelay}>
            <TooltipTrigger asChild>
              <SearchTrigger compact={rail} />
            </TooltipTrigger>
            <TooltipContent side="right">
              Search
              <PaletteKbd className="ml-1.5" />
            </TooltipContent>
          </Tooltip>
        </div>

        <div className="flex-1 overflow-x-hidden overflow-y-auto">
          <SidebarNav
            collapsed={rail}
            capabilities={capabilities}
            isAdmin={isAdmin}
          />
        </div>

        {menu === "main" && (
          <div
            inert={rail}
            className={cn(
              "grid px-2 transition-[grid-template-rows,opacity] duration-200 ease-out",
              rail ? "grid-rows-[0fr] opacity-0" : "grid-rows-[1fr]",
            )}
          >
            {/* Expanded width, so the card never rewraps while it folds. */}
            <div
              className="min-h-0 overflow-hidden pb-2"
              style={{ width: width - 16 }}
            >
              <SidebarTips
                hasSecondFactor={hasSecondFactor}
                capabilities={capabilities}
                isAdmin={isAdmin}
              />
            </div>
          </div>
        )}

        <hr className="mx-2 border-t border-sidebar-border" />
        <div className="space-y-0.5 p-2">
          {menu === "main" && (
            <>
              <Tooltip delayDuration={tipDelay}>
                <TooltipTrigger asChild>
                  <Link
                    href="/settings"
                    aria-label="Settings"
                    className={FOOTER_LINK}
                  >
                    <Settings className="size-4 shrink-0 group-hover:text-foreground" />
                    <NavLabel hidden={rail}>Settings</NavLabel>
                    <SubmenuChevron hidden={rail} />
                  </Link>
                </TooltipTrigger>
                <TooltipContent side="right">Settings</TooltipContent>
              </Tooltip>
              <Tooltip delayDuration={tipDelay}>
                <TooltipTrigger asChild>
                  <a
                    href={docsUrl("docs.home")}
                    target="_blank"
                    rel="noreferrer"
                    aria-label="Documentation"
                    className={FOOTER_LINK}
                  >
                    <BookOpen className="size-4 shrink-0 group-hover:text-foreground" />
                    <NavLabel hidden={rail}>Documentation</NavLabel>
                  </a>
                </TooltipTrigger>
                <TooltipContent side="right">Documentation</TooltipContent>
              </Tooltip>
            </>
          )}
          <Tooltip delayDuration={tipDelay}>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={toggle}
                aria-label={rail ? "Expand sidebar" : "Collapse sidebar"}
                className={FOOTER_LINK}
              >
                {rail ? (
                  <PanelLeftOpen className="size-4 shrink-0 group-hover:text-foreground" />
                ) : (
                  <PanelLeftClose className="size-4 shrink-0 group-hover:text-foreground" />
                )}
                <NavLabel hidden={rail}>Collapse</NavLabel>
                <kbd
                  className={cn(
                    "ml-auto rounded border border-border bg-muted px-1 text-[10px]",
                    FADE,
                    rail && "opacity-0",
                  )}
                >
                  [
                </kbd>
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">
              {rail ? "Expand sidebar" : "Collapse sidebar"}
              <kbd className="ml-1.5 rounded border border-border bg-muted px-1 text-[10px]">
                [
              </kbd>
            </TooltipContent>
          </Tooltip>
        </div>
      </div>

      <div
        onPointerDown={startResize}
        onDoubleClick={resetWidth}
        title="Double-click to reset the width"
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
