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
import { DeploLogo } from "@/components/logo";
import { sidebarMenuFor } from "@/components/layout/nav-config/active-route";
import { SidebarNav, SubmenuChevron } from "./sidebar-nav";
import { SidebarTips } from "./sidebar-tips";
import { RAIL_WIDTH, useSidebar } from "./sidebar-state";
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
  "group flex w-full cursor-pointer items-center gap-2.5 overflow-hidden rounded-md px-3 py-2 text-left text-sm whitespace-nowrap text-muted-foreground transition-colors hover:bg-surface hover:text-foreground focus-visible:bg-surface";

function RailLabel({
  hidden,
  children,
}: {
  hidden: boolean;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn("transition-opacity duration-100", hidden && "opacity-0")}
    >
      {children}
    </span>
  );
}

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
    toggle,
    startResize,
    resetWidth,
  } = useSidebar();
  const rail = mode === "rail";
  const hidden = mode === "hidden";
  const tipDelay = rail ? 0 : 400;
  return (
    <aside
      data-collapsed={mode !== "expanded"}
      inert={hidden}
      style={{ width: hidden ? 0 : rail ? RAIL_WIDTH : width - peek }}
      className={cn(
        "sticky top-0 hidden h-screen shrink-0 overflow-hidden border-r border-sidebar-border bg-sidebar md:block",
        hydrated && !dragging && "transition-[width] duration-200 ease-out",
        hidden && "border-r-0",
      )}
    >
      <div
        style={{
          width: rail ? RAIL_WIDTH : width,
          transform:
            hidden || peek
              ? `translateX(-${hidden ? width : peek}px)`
              : undefined,
        }}
        className={cn(
          "flex h-full flex-col",
          hydrated &&
            !dragging &&
            "transition-[transform,width] duration-200 ease-out",
        )}
      >
        <div
          className={cn(
            "flex h-14 items-center pr-2",
            rail ? "pl-[18px]" : "pl-5",
          )}
        >
          <Link href="/" className="cursor-pointer" aria-label="Deplo home">
            <DeploLogo showWordmark={!rail} />
          </Link>
        </div>

        <div className="px-2 pb-1">
          <SearchTrigger compact={rail} />
        </div>

        <div className="flex-1 overflow-x-hidden overflow-y-auto">
          <SidebarNav
            collapsed={rail}
            capabilities={capabilities}
            isAdmin={isAdmin}
          />
        </div>

        {menu === "main" && !rail && (
          <div className="px-2 pb-2">
            <SidebarTips
              hasSecondFactor={hasSecondFactor}
              capabilities={capabilities}
              isAdmin={isAdmin}
            />
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
                    <RailLabel hidden={rail}>Settings</RailLabel>
                    {!rail && <SubmenuChevron />}
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
                    <RailLabel hidden={rail}>Documentation</RailLabel>
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
                <RailLabel hidden={rail}>Collapse</RailLabel>
                {!rail && (
                  <kbd className="ml-auto rounded border border-border bg-muted px-1 text-[10px]">
                    [
                  </kbd>
                )}
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

      {!rail && (
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
      )}
    </aside>
  );
}

export function SidebarExpandButton() {
  const { mode, toggle } = useSidebar();
  if (mode !== "hidden") return null;

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
